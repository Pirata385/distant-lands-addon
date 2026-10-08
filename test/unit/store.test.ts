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
  assert.equal(store.version(0, 3, -5), 0, 'no data');
  assert.equal(store.put(0, 3, -5, chunk(4, 70), 100), true);
  const v1 = store.version(0, 3, -5);
  assert.notEqual(v1, 0);
  assert.equal(store.put(0, 3, -5, chunk(4, 70), 200), false, 'same content');
  assert.equal(store.version(0, 3, -5), v1);
  assert.equal(store.get(0, 3, -5)!.sampledAt, 200, 'sample time refreshed');
  assert.equal(store.put(0, 3, -5, chunk(4, 71), 300), true);
  assert.notEqual(store.version(0, 3, -5), v1);
  assert.ok(store.dataEpoch >= 2);
});

test('versions survive memory eviction and reload (no re-mesh storm when the cache cycles)', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 64, persist: true });
  store.put(0, 1, 1, chunk(4, 70, rgb(91, 140, 61)), 1);
  const v = store.version(0, 1, 1);
  store.put(0, 40, 40, chunk(4, 66), 1); // other region: evicts and persists the first
  assert.equal(store.stats().regionsInMemory, 1);
  assert.equal(store.version(0, 1, 1), v, 'same content after reload, same version');
});

test('put ignores chunks sampled at another resolution', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: true });
  assert.equal(store.put(0, 0, 0, chunk(8, 70), 1), false);
  assert.equal(store.get(0, 0, 0), undefined);
});

test('a block edit made while the chunk was being sampled keeps it dirty', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: true });
  store.markDirty(0, 1, 1, 50);
  store.put(0, 1, 1, chunk(4, 70), 40); // sampling started before the edit
  assert.ok(store.isDirty(0, 1, 1));
  store.put(0, 1, 1, chunk(4, 71), 60);
  assert.ok(!store.isDirty(0, 1, 1));
});

test('the dirty-chunk set is bounded', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: true });
  for (let i = 0; i < 20000; i++) store.markDirty(0, i, -i, i);
  assert.ok(store.stats().dirtyChunks <= 8192, `${store.stats().dirtyChunks}`);
  assert.ok(store.isDirty(0, 19999, -19999), 'newest edits are kept');
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
  const removed = store.evictStorage([{ dim: 0, cx: 0, cz: 0, r: 0 }], before - 1);
  assert.equal(removed, 1);
  assert.ok(!kv.data.has(regionKey(0, 80, 0)), 'farthest region removed');
  assert.ok(kv.data.has(regionKey(0, 0, 0)));
  assert.equal(store.get(0, 640, 0), undefined);
  assert.equal(store.storageShort, false);
});

test('storage eviction never removes regions inside a player\'s LOD radius', () => {
  const kv = new MemKV();
  const store = new LodStore(kv, { res: 4, memoryChunks: 4096, persist: true });
  for (const cx of [0, 20, 40, 640]) store.put(0, cx, 0, chunk(4, 64), 1);
  store.flush(10);
  const removed = store.evictStorage([{ dim: 0, cx: 0, cz: 0, r: 24 }], 1);
  assert.equal(removed, 2, 'only the regions beyond the radius go');
  assert.ok(kv.data.has(regionKey(0, 0, 0)) && kv.data.has(regionKey(0, 2, 0)), 'regions within 24 chunks kept');
  assert.ok(!kv.data.has(regionKey(0, 5, 0)) && !kv.data.has(regionKey(0, 80, 0)));
  assert.equal(store.storageShort, true, 'the budget cannot be met: reported, not forced');
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
