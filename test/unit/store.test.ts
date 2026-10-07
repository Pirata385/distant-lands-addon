import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lru } from '../../src/core/util/lru';
import { LodStore, KV, regionKey } from '../../src/core/store';
import { ChunkLod, NO_DATA } from '../../src/core/lod/chunk-lod';
import { encodeRegion } from '../../src/core/lod/codec';
import { rgb } from '../../src/core/palette';

class MemKV implements KV {
  data = new Map<string, string>();
  reads = 0;
  writes = 0;
  get(key: string) {
    this.reads++;
    return this.data.get(key);
  }
  set(key: string, value: string | undefined) {
    this.writes++;
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
  keys() {
    return [...this.data.keys()];
  }
  totalBytes() {
    let n = 0;
    for (const [k, v] of this.data) n += (k.length + v.length) * 2;
    return n;
  }
}

function chunk(res: number, h: number, color = rgb(80, 140, 60)): ChunkLod {
  const c = new ChunkLod(res);
  c.base.height.fill(h);
  c.base.color.fill(color);
  c.buildMips();
  return c;
}

test('lru evicts the least recently used entry and get refreshes recency', () => {
  const evicted: string[] = [];
  const lru = new Lru<string, number>(2, (k) => evicted.push(k));
  lru.set('a', 1);
  lru.set('b', 2);
  lru.get('a');
  lru.set('c', 3);
  assert.deepEqual(evicted, ['b']);
  assert.equal(lru.size, 2);
  assert.equal(lru.peek('a'), 1);
  lru.setCapacity(1);
  assert.equal(lru.size, 1);
});

test('put/get round-trips and versions only change with content', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: true });
  assert.equal(store.get(0, 3, -5), undefined);
  assert.equal(store.put(0, 3, -5, chunk(4, 70), 100), true);
  assert.equal(store.version(0, 3, -5), 1);
  assert.equal(store.put(0, 3, -5, chunk(4, 70), 200), false, 'same content');
  assert.equal(store.version(0, 3, -5), 1);
  assert.equal(store.get(0, 3, -5)!.sampledAt, 200, 'sample time refreshed');
  assert.equal(store.put(0, 3, -5, chunk(4, 71), 300), true);
  assert.equal(store.version(0, 3, -5), 2);
  assert.ok(store.dataEpoch >= 2);
});

test('regions load lazily from storage', () => {
  const kv = new MemKV();
  const chunks: (ChunkLod | undefined)[] = new Array(64).fill(undefined);
  chunks[9] = chunk(4, 90); // local (1,1)
  kv.data.set(regionKey(0, -1, 2), encodeRegion(chunks, 4));
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  assert.equal(kv.reads, 0);
  const got = store.get(0, -8 + 1, 16 + 1);
  assert.ok(got);
  assert.equal(got!.base.height[0], 90);
  assert.equal(got!.sampledAt, -1, 'restored data has unknown age');
  assert.equal(kv.reads, 1);
  store.get(0, -8 + 2, 16 + 1);
  assert.equal(kv.reads, 1, 'region read once');
});

test('flush writes only dirty regions', () => {
  const kv = new MemKV();
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  store.put(0, 0, 0, chunk(4, 64), 1);
  store.put(0, 100, 100, chunk(4, 65), 1);
  assert.equal(store.stats().dirtyRegions, 2);
  assert.equal(store.flush(1), 1);
  assert.equal(store.stats().dirtyRegions, 1);
  assert.equal(store.flush(10), 1);
  assert.equal(store.flush(10), 0);
  const reloaded = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  assert.equal(reloaded.get(0, 100, 100)!.base.height[3], 65);
});

test('memory eviction persists dirty regions before dropping them', () => {
  const kv = new MemKV();
  const store = new LodStore(kv, { res: 4, memoryChunks: 64, persist: true });
  store.put(0, 0, 0, chunk(4, 64), 1);
  store.put(0, 40, 40, chunk(4, 66), 1); // different region -> evicts the first
  assert.equal(store.stats().regionsInMemory, 1);
  assert.equal(store.get(0, 0, 0)!.base.height[0], 64, 'reloaded from storage');
});

test('without persistence nothing is written', () => {
  const kv = new MemKV();
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: false });
  store.put(0, 0, 0, chunk(4, 64), 1);
  assert.equal(store.flush(10), 0);
  assert.equal(kv.writes, 0);
});

test('storage eviction removes the regions farthest from players first', () => {
  const kv = new MemKV();
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  store.put(0, 0, 0, chunk(4, 64), 1);
  store.put(0, 64, 0, chunk(4, 64), 1);
  store.put(0, 640, 0, chunk(4, 64), 1);
  store.flush(10);
  const before = kv.totalBytes();
  const removed = store.evictStorage([{ dim: 0, cx: 0, cz: 0 }], before - 1);
  assert.equal(removed, 1);
  assert.ok(!kv.data.has(regionKey(0, 80, 0)), 'farthest region removed');
  assert.ok(kv.data.has(regionKey(0, 0, 0)));
  assert.equal(store.get(0, 640, 0), undefined);
});

test('staleness: missing, dirty, old, restored and other-resolution chunks', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: true });
  assert.equal(store.isStale(0, 1, 1, 1000, 500), true, 'missing');
  store.put(0, 1, 1, chunk(4, 64), 900);
  assert.equal(store.isStale(0, 1, 1, 1000, 500), false);
  assert.equal(store.isStale(0, 1, 1, 1500, 500), true, 'old');
  store.markDirty(0, 1, 1);
  assert.equal(store.isStale(0, 1, 1, 1000, 500), true, 'dirty');
  store.put(0, 1, 1, chunk(4, 64), 1000);
  assert.equal(store.isStale(0, 1, 1, 1000, 500), false, 'resampled clears dirty');
  store.put(0, 2, 2, chunk(8, 64), 1000);
  assert.equal(store.isStale(0, 2, 2, 1000, 500), true, 'resolution changed');
});

test('corrupt stored regions are discarded instead of throwing', () => {
  const kv = new MemKV();
  kv.data.set(regionKey(0, 0, 0), 'L1|4|zz|nope');
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  assert.equal(store.get(0, 0, 0), undefined);
  assert.equal(kv.data.has(regionKey(0, 0, 0)), false);
  assert.equal(store.stats().corruptRegions, 1);
});

test('clear removes memory and persisted data', () => {
  const kv = new MemKV();
  kv.data.set('other:key', 'keep');
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  store.put(0, 0, 0, chunk(4, 64), 1);
  store.flush(10);
  store.clear();
  assert.equal(store.get(0, 0, 0), undefined);
  assert.deepEqual(kv.keys(), ['other:key']);
  assert.ok(store.get(0, 0, 0) === undefined && NO_DATA < 0);
});
