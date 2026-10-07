import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRadius } from '../../src/core/radius';
import { Capture } from '../../src/core/capture';
import { LodGenerator, GEN_TIMEOUT_TICKS, GEN_BACKOFF_TICKS, areaName } from '../../src/core/generator';
import { WorkRegistry, PlayerFocus } from '../../src/core/work';
import { LodStore, KV } from '../../src/core/store';
import { VEG_CANOPY } from '../../src/core/sampler';
import { FakeDimension } from '../fakes/terrain';

class MemKV implements KV {
  data = new Map<string, string>();
  get(k: string) {
    return this.data.get(k);
  }
  set(k: string, v: string | undefined) {
    if (v === undefined) this.data.delete(k);
    else this.data.set(k, v);
  }
  keys() {
    return [...this.data.keys()];
  }
  totalBytes() {
    return 0;
  }
}

function disk(cx: number, cz: number, r: number): Set<string> {
  const s = new Set<string>();
  for (let z = -r; z <= r; z++) for (let x = -r; x <= r; x++) if (x * x + z * z <= r * r) s.add(`${cx + x},${cz + z}`);
  return s;
}

function drain(gen: Generator<void, boolean, void>): boolean {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

const SAMPLER = { waterDepth: true, vegetation: VEG_CANOPY };

function focus(dim: FakeDimension, over: Partial<PlayerFocus> = {}): PlayerFocus {
  return { id: 'p', dim, x: 8, z: 8, dirX: 0, dirZ: 1, loadedRadius: 4, lodRadius: 12, flying: false, ...over };
}

test('radius detection finds the circular loaded radius', () => {
  const dim = new FakeDimension();
  dim.loaded = disk(10, -3, 9);
  assert.equal(detectRadius(dim, 10 * 16 + 5, -3 * 16 + 7, 36), 9);
  dim.loaded = disk(0, 0, 20);
  assert.equal(detectRadius(dim, 8, 8, 36), 20);
});

test('radius detection ignores a single odd direction (ticking area, other player)', () => {
  const dim = new FakeDimension();
  dim.loaded = disk(0, 0, 8);
  for (let x = 9; x < 30; x++) dim.loaded.add(`${x},0`);
  for (let z = 3; z <= 8; z++) dim.loaded.delete(`0,${-z}`);
  assert.equal(detectRadius(dim, 8, 8, 36), 8);
});

test('radius detection returns 0 when the player chunk is not loaded', () => {
  const dim = new FakeDimension();
  dim.loaded = new Set();
  assert.equal(detectRadius(dim, 8, 8, 36), 0);
});

test('capture samples missing loaded chunks edge-first, then dirty ones', () => {
  const dim = new FakeDimension();
  dim.loaded = disk(0, 0, 3);
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const cap = new Capture(store, new WorkRegistry());
  const order: string[] = [];
  const orig = store.put.bind(store);
  store.put = (d, cx, cz, lod, now) => {
    order.push(`${cx},${cz}`);
    return orig(d, cx, cz, lod, now);
  };
  cap.update([focus(dim, { loadedRadius: 3 })], 100, 20 * 600);
  while (drain(cap.work(100, 4, SAMPLER)));
  assert.equal(order.length, disk(0, 0, 3).size);
  const first = order[0].split(',').map(Number);
  assert.equal(Math.round(Math.hypot(first[0], first[1])), 3, 'edge chunk first');
  for (const k of dim.loaded!) assert.ok(store.has(0, ...(k.split(',').map(Number) as [number, number])));
  order.length = 0;
  store.markDirty(0, 1, 1);
  cap.update([focus(dim, { loadedRadius: 3 })], 200, 20 * 600);
  while (drain(cap.work(200, 4, SAMPLER)));
  assert.deepEqual(order, ['1,1']);
});

test('capture never touches unloaded chunks', () => {
  const dim = new FakeDimension();
  dim.loaded = new Set(['0,0']);
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const cap = new Capture(store, new WorkRegistry());
  cap.update([focus(dim, { loadedRadius: 3 })], 1, 1000);
  while (drain(cap.work(1, 4, SAMPLER)));
  assert.ok(store.has(0, 0, 0));
  assert.ok(!store.has(0, 1, 0));
});

/** Fake dimension whose ticking-area commands load the requested chunks. */
function tickingDim(accept = true): FakeDimension {
  const dim = new FakeDimension();
  dim.loaded = disk(0, 0, 4);
  dim.command = (cmd: string) => {
    dim.commands.push(cmd);
    const add = /^tickingarea add (-?\d+) -?\d+ (-?\d+) (-?\d+) -?\d+ (-?\d+) (\S+)$/.exec(cmd);
    if (add) {
      if (!accept) return false;
      const [x1, z1, x2, z2] = add.slice(1, 5).map(Number);
      for (let cz = Math.floor(z1 / 16); cz <= Math.floor(z2 / 16); cz++)
        for (let cx = Math.floor(x1 / 16); cx <= Math.floor(x2 / 16); cx++) dim.loaded!.add(`${cx},${cz}`);
    }
    return true;
  };
  return dim;
}

test('generator loads aligned batches with a margin, samples them and removes the area', () => {
  const dim = tickingDim();
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const gen = new LodGenerator(store, new WorkRegistry());
  const opts = { batch: 4, concurrency: 1, priority: 0, res: 4, sampler: SAMPLER, paused: false };
  gen.update([focus(dim, { loadedRadius: 4, lodRadius: 10 })], 10, opts);
  const add = dim.commands.find((c) => c.startsWith('tickingarea add'))!;
  assert.match(add, new RegExp(`${areaName(0)}$`));
  const [x1, , z1, x2, , z2] = add.split(' ').slice(2, 8).map(Number);
  assert.equal((x2 + 1 - x1) / 16, 6, '4 chunks + 1 chunk margin on each side');
  assert.equal((z2 + 1 - z1) / 16, 6);
  assert.ok(x1 % 16 === 0, 'area starts on a chunk border');
  for (let t = 11; t < 40; t++) {
    gen.update([focus(dim, { loadedRadius: 4, lodRadius: 10 })], t, opts);
    while (drain(gen.work(t)));
  }
  const bx0 = x1 / 16 + 1;
  const bz0 = z1 / 16 + 1;
  assert.ok(bx0 % 4 === 0 && bz0 % 4 === 0, 'batch aligned to its size');
  for (let cz = bz0; cz < bz0 + 4; cz++) for (let cx = bx0; cx < bx0 + 4; cx++) assert.ok(store.has(0, cx, cz), `${cx},${cz}`);
  assert.ok(dim.commands.includes(`tickingarea remove ${areaName(0)}`));
  gen.update([focus(dim, { loadedRadius: 4, lodRadius: 10 })], 40, opts);
  assert.equal(gen.activeCount, 1, 'next batch started');
});

test('backs off when ticking area limit reached', () => {
  const dim = tickingDim(false);
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const notes: string[] = [];
  const gen = new LodGenerator(store, new WorkRegistry(), (m) => notes.push(m));
  const opts = { batch: 4, concurrency: 1, priority: 0, res: 4, sampler: SAMPLER, paused: false };
  gen.update([focus(dim)], 100, opts);
  gen.update([focus(dim)], 101, opts);
  gen.update([focus(dim)], 100 + GEN_BACKOFF_TICKS - 1, opts);
  assert.equal(dim.commands.filter((c) => c.startsWith('tickingarea add')).length, 1);
  assert.equal(notes.length, 1);
  gen.update([focus(dim)], 100 + GEN_BACKOFF_TICKS + 1, opts);
  assert.equal(dim.commands.filter((c) => c.startsWith('tickingarea add')).length, 2);
  assert.equal(notes.length, 1, 'operators are told once');
});

test('generator times out batches that never load and cancels on demand', () => {
  const dim = tickingDim();
  dim.command = (cmd) => {
    dim.commands.push(cmd);
    return true; // accepted but chunks never load
  };
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const gen = new LodGenerator(store, new WorkRegistry());
  const opts = { batch: 2, concurrency: 2, priority: 0, res: 4, sampler: SAMPLER, paused: false };
  gen.update([focus(dim)], 0, opts);
  assert.equal(gen.activeCount, 2);
  gen.update([focus(dim)], GEN_TIMEOUT_TICKS + 1, opts);
  while (drain(gen.work(GEN_TIMEOUT_TICKS + 1)));
  assert.equal(dim.commands.filter((c) => c.startsWith('tickingarea remove')).length, 2);
  gen.update([focus(dim)], GEN_TIMEOUT_TICKS + 2, opts);
  gen.cancelAll();
  assert.equal(gen.activeCount, 0);
  assert.equal(dim.commands.filter((c) => c.startsWith('tickingarea remove')).length, 4);
});

test('paused generation starts nothing and startup cleanup removes leftovers', () => {
  const dim = tickingDim();
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const gen = new LodGenerator(store, new WorkRegistry());
  gen.update([focus(dim)], 0, { batch: 4, concurrency: 1, priority: 0, res: 4, sampler: SAMPLER, paused: true });
  assert.equal(gen.activeCount, 0);
  gen.cleanup(dim);
  for (let i = 0; i < 10; i++) assert.ok(dim.commands.includes(`tickingarea remove ${areaName(i)}`));
});

test('radius detection is exact for every radius from 1 to 32', () => {
  const dim = new FakeDimension();
  for (let r = 1; r <= 32; r++) {
    dim.loaded = disk(-7, 12, r);
    assert.equal(detectRadius(dim, -7 * 16 + 3, 12 * 16 + 9, 36), r, `radius ${r}`);
  }
});
