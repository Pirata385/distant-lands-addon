import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshTile, tileSignature, QUAD_STRIDE, K_TOP, K_WALL, TOP_OFFSET, StyleParams, CellData, CellLookup } from '../../src/core/mesher';
import { StoreLookup } from '../../src/core/cells';
import { LodStore, KV } from '../../src/core/store';
import { ChunkLod, F_WATER, NO_DATA, aggregate } from '../../src/core/lod/chunk-lod';
import { rgb } from '../../src/core/palette';
import type { Tile } from '../../src/core/planner';

const STYLE: StyleParams = { style: 0, relief: 0, waterDepth: false };

/** Lookup over an analytic world: height/colour/flags as functions of the cell's min corner. */
class FnLookup implements CellLookup {
  constructor(private readonly fn: (size: number, x: number, z: number) => CellData | null) {}
  cell(size: number, x: number, z: number, out: CellData): boolean {
    const v = this.fn(size, x, z);
    if (!v) return false;
    out.h = v.h;
    out.c = v.c;
    out.f = v.f;
    out.d = v.d;
    return true;
  }
}

function quads(buf: Float32Array) {
  const out = [];
  for (let i = 0; i < buf.length; i += QUAD_STRIDE) {
    out.push({
      kind: buf[i], x: buf[i + 1], y: buf[i + 2], z: buf[i + 3], a: buf[i + 4], b: buf[i + 5],
      r: buf[i + 6], g: buf[i + 7], bl: buf[i + 8], level: buf[i + 9],
    });
  }
  return out;
}

const tile = (x0: number, z0: number, size: number, cell: number): Tile => ({ key: `${x0},${z0},${size}`, x0, z0, size, cell, dist: 300 });
const GREEN = rgb(90, 150, 60);

test('a flat uniform chunk collapses into one top quad', () => {
  const look = new FnLookup(() => ({ h: 70, c: GREEN, f: 0, d: 0 }));
  const q = quads(meshTile(tile(32, -16, 16, 4), look, STYLE));
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, K_TOP);
  assert.equal(q[0].x, 8, 'x is relative to the tile origin');
  assert.equal(q[0].z, 8);
  assert.ok(Math.abs(q[0].y - (70 - TOP_OFFSET)) < 1e-5);
  assert.equal(q[0].a, 8);
  assert.equal(q[0].b, 8);
});

test('a height step creates walls on the high side with the right height', () => {
  const look = new FnLookup((_s, x) => ({ h: x < 8 ? 70 : 60, c: GREEN, f: 0, d: 0 }));
  const q = quads(meshTile(tile(0, 0, 16, 4), look, STYLE));
  const walls = q.filter((v) => v.kind === K_WALL);
  const tops = q.filter((v) => v.kind === K_TOP);
  assert.equal(tops.length, 4, 'four merged 8x8 quadrants (squares only)');
  assert.ok(tops.every((t) => t.a === 4));
  // High cells adjacent to the step: x in [4,8) for 4 rows, plus the high cells at the outer west edge (x<0 is 70 too).
  assert.equal(walls.length, 4);
  for (const w of walls) {
    assert.equal(w.x, 6);
    assert.equal(w.b, 5.5, 'half height covers 70 down to one block below 60');
    assert.ok(Math.abs(w.y + w.b - (70 - TOP_OFFSET)) < 1e-5, 'wall top meets the top face');
    assert.ok(Math.abs(w.y - w.b - (59 - TOP_OFFSET)) < 1e-5, 'wall bottom one block below the low neighbour');
    assert.equal(w.a, 2);
  }
  assert.ok(walls[0].g < tops[0].g, 'walls are darker than tops');
});

test('water never gets walls and missing cells produce nothing', () => {
  const look = new FnLookup((_s, x, z) => {
    if (z >= 8) return null;
    return x < 8 ? { h: 63, c: rgb(40, 80, 200), f: F_WATER, d: 10 } : { h: 40, c: GREEN, f: 0, d: 0 };
  });
  const q = quads(meshTile(tile(0, 0, 16, 4), look, STYLE));
  assert.ok(q.every((v) => v.z < 8 || v.kind === K_WALL));
  assert.equal(q.filter((v) => v.kind === K_WALL).length, 0);
  assert.equal(q.filter((v) => v.kind === K_TOP).length, 2);
});

test('walls appear at tile borders from neighbour data', () => {
  const look = new FnLookup((_s, x) => ({ h: x >= 0 ? 80 : 64, c: GREEN, f: 0, d: 0 }));
  const q = quads(meshTile(tile(0, 0, 16, 16), look, STYLE));
  const walls = q.filter((v) => v.kind === K_WALL);
  assert.equal(walls.length, 1);
  assert.equal(walls[0].b, 8.5);
});

test('colours stay within 0..1 and styles apply', () => {
  const look = new FnLookup((_s, x, z) => ({ h: 64 + ((x + z) & 31), c: rgb(250, 250, 250), f: 0, d: 0 }));
  const shaded = quads(meshTile(tile(0, 0, 16, 4), look, { style: 0, relief: 1, waterDepth: false }));
  for (const v of shaded) for (const ch of [v.r, v.g, v.bl]) assert.ok(ch >= 0 && ch <= 1);
  const debug = quads(meshTile(tile(0, 0, 16, 4), look, { style: 4, relief: 0, waterDepth: false }));
  assert.notDeepEqual([debug[0].r, debug[0].g], [shaded[0].r, shaded[0].g]);
});

test('relief shading brightens slopes facing the light and darkens the others', () => {
  const up = new FnLookup((_s, x) => ({ h: 64 + Math.floor(x / 4), c: rgb(128, 128, 128), f: 0, d: 0 }));
  const down = new FnLookup((_s, x) => ({ h: 64 - Math.floor(x / 4), c: rgb(128, 128, 128), f: 0, d: 0 }));
  const s: StyleParams = { style: 0, relief: 1, waterDepth: false };
  const a = quads(meshTile(tile(0, 0, 16, 4), up, s)).find((v) => v.kind === K_TOP)!;
  const b = quads(meshTile(tile(0, 0, 16, 4), down, s)).find((v) => v.kind === K_TOP)!;
  assert.ok(a.r !== b.r, 'opposite slopes shade differently');
});

test('deep water is darker than shallow water when depth shading is on', () => {
  const look = (d: number) => new FnLookup(() => ({ h: 63, c: rgb(60, 110, 220), f: F_WATER, d }));
  const s: StyleParams = { style: 0, relief: 0, waterDepth: true };
  const shallow = quads(meshTile(tile(0, 0, 16, 16), look(2), s))[0];
  const deep = quads(meshTile(tile(0, 0, 16, 16), look(30), s))[0];
  assert.ok(deep.bl < shallow.bl);
});

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

test('store lookup serves chunk levels, finer requests and aggregated big cells', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const heights = [70, 74, 66, 90];
  for (let k = 0; k < 4; k++) {
    const lod = new ChunkLod(4);
    lod.base.height.fill(heights[k]);
    lod.base.color.fill(rgb(10 * k, 100, 50));
    lod.buildMips();
    store.put(0, k & 1, k >> 1, lod, 1);
  }
  const look = new StoreLookup(store, 0);
  const out: CellData = { h: 0, c: 0, f: 0, d: 0 };
  assert.equal(look.cell(4, 4, 4, out), true);
  assert.equal(out.h, 70);
  assert.equal(look.cell(2, 18, 2, out), true, 'finer than the data uses the base level');
  assert.equal(out.h, 74);
  assert.equal(look.cell(32, 0, 0, out), true);
  const exp = { h: 0, c: 0, f: 0, d: 0 };
  aggregate(heights, heights.map((_, k) => rgb(10 * k, 100, 50)), [0, 0, 0, 0], [0, 0, 0, 0], 4, exp);
  assert.equal(out.h, exp.h);
  assert.equal(look.cell(16, 64, 64, out), false, 'no data');
  assert.equal(look.cell(64, 0, 0, out), true, 'partial data still aggregates');
  assert.ok(out.h !== NO_DATA);
});

test('conservative tiles use the lowest sample of each cell', () => {
  const store = new LodStore(new MemKV(), { res: 4, memoryChunks: 4096, persist: false });
  const lod = new ChunkLod(4);
  const hs = [70, 74, 66, 90];
  for (let k = 0; k < 16; k++) lod.base.height[k] = hs[k % 4];
  lod.base.color.fill(rgb(80, 140, 60));
  lod.buildMips();
  store.put(0, 0, 0, lod, 1);
  const look = new StoreLookup(store, 0);
  const t: Tile = { key: '0,0,16', x0: 0, z0: 0, size: 16, cell: 8, dist: 100 };
  const normal = quads(meshTile(t, look, STYLE)).filter((v) => v.kind === K_TOP);
  const safe = quads(meshTile({ ...t, conservative: true }, look, STYLE)).filter((v) => v.kind === K_TOP);
  assert.ok(Math.min(...safe.map((v) => v.y)) < Math.min(...normal.map((v) => v.y)));
  for (const v of safe) assert.ok(Math.abs(v.y - (66 - TOP_OFFSET)) < 1e-5 || Math.abs(v.y - (70 - TOP_OFFSET)) < 1e-5, `y=${v.y}`);
});

test('tile signatures cover every chunk the mesher reads, including corners and whole neighbour cells', () => {
  const versions = new Map<string, number>();
  const store = { version: (_d: number, cx: number, cz: number) => versions.get(`${cx},${cz}`) ?? 0 };
  const sig = (t: Tile) => tileSignature(t, 0, store, 0);
  const touch = (cx: number, cz: number) => versions.set(`${cx},${cz}`, (versions.get(`${cx},${cz}`) ?? 0) + 1);
  const chunkTile: Tile = { key: '32,32,16', x0: 32, z0: 32, size: 16, cell: 4, dist: 100 };
  const big: Tile = { key: '0,0,64', x0: 0, z0: 0, size: 64, cell: 64, dist: 400 };
  for (const [t, cx, cz] of [
    [chunkTile, 1, 1], // diagonal neighbour (walls read all 8 neighbours)
    [chunkTile, 3, 2], // edge neighbour
    [big, -4, 0], // far side of the 64-block neighbour cell
    [big, 7, 7], // diagonal neighbour cell
  ] as const) {
    const before = sig(t);
    touch(cx, cz);
    assert.notEqual(sig(t), before, `${t.key}: chunk ${cx},${cz}`);
  }
  const before = sig(chunkTile);
  touch(5, 5);
  touch(0, 2);
  assert.equal(sig(chunkTile), before, 'chunks the mesher does not read leave the signature alone');
});
