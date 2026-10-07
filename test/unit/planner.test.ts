import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTiles, cellSizeFor, PlanInput, Tile, estimateQuads, HYSTERESIS } from '../../src/core/planner';

function plan(input: PlanInput): Tile[] {
  const gen = planTiles(input);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

function ringChunks(px: number, pz: number, rin: number, rout: number): Set<string> {
  const pcx = Math.floor(px / 16);
  const pcz = Math.floor(pz / 16);
  const set = new Set<string>();
  const r = Math.min(rout, 32);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 <= r * r && d2 > rin * rin) set.add(`${pcx + dx},${pcz + dz}`);
    }
  }
  return set;
}

function covered(tiles: Tile[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tiles) {
    for (let z = t.z0; z < t.z0 + t.size; z += 16) {
      for (let x = t.x0; x < t.x0 + t.size; x += 16) {
        const k = `${x / 16},${z / 16}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
  }
  return m;
}

test('cell size grows by powers of two with distance', () => {
  assert.equal(cellSizeFor(10, 4, 12), 4);
  assert.equal(cellSizeFor(128, 4, 12), 8);
  assert.equal(cellSizeFor(200, 4, 12), 16);
  assert.equal(cellSizeFor(400, 4, 12), 32);
  assert.equal(cellSizeFor(5000, 4, 12), 64);
  assert.equal(cellSizeFor(128, 2, 22), 4);
});

for (const [px, pz, rin, rout] of [
  [8, 8, 8, 24],
  [-1000.5, 333.2, 10, 32],
  [70000, -70000, 4, 12],
  [0, 0, 12, 40],
] as const) {
  test(`tiles cover the LOD ring exactly once (${px},${pz},${rin},${rout})`, () => {
    const tiles = plan({ px, pz, rinChunks: rin, routChunks: rout, res: 4, quality: 12 });
    const cov = covered(tiles);
    const ring = ringChunks(px, pz, rin, rout);
    for (const k of ring) assert.equal(cov.get(k), 1, `chunk ${k} covered ${cov.get(k) ?? 0} times`);
    for (const k of cov.keys()) assert.ok(ring.has(k), `tile covers chunk ${k} outside the ring`);
  });
}

test('tiles are aligned and cells divide them', () => {
  const tiles = plan({ px: 123, pz: -456, rinChunks: 6, routChunks: 32, res: 4, quality: 12 });
  for (const t of tiles) {
    assert.ok(t.x0 % t.size === 0 && t.z0 % t.size === 0, `unaligned ${t.key}`);
    assert.ok([16, 32, 64].includes(t.size));
    assert.ok(t.cell >= 4 && t.cell <= 64 && t.size % t.cell === 0, JSON.stringify(t));
    assert.ok(t.size === 16 || t.cell === t.size, 'big tiles are a single cell');
    assert.equal(t.key, `${t.x0},${t.z0},${t.size}`);
  }
});

test('detail never gets coarser than the distance rule allows', () => {
  const px = 50;
  const pz = 50;
  const tiles = plan({ px, pz, rinChunks: 4, routChunks: 32, res: 4, quality: 12 });
  for (const t of tiles) {
    const nx = Math.max(t.x0, Math.min(px, t.x0 + t.size));
    const nz = Math.max(t.z0, Math.min(pz, t.z0 + t.size));
    const near = Math.hypot(px - nx, pz - nz);
    if (t.size > 16) assert.ok(cellSizeFor(near, 4, 12) >= t.size, `tile ${t.key} too coarse`);
    else assert.equal(t.cell, Math.min(16, cellSizeFor(t.dist, 4, 12)));
  }
  const near = tiles.filter((t) => t.dist < 150);
  const far = tiles.filter((t) => t.dist > 400);
  const avg = (ts: Tile[]) => ts.reduce((s, t) => s + t.cell, 0) / ts.length;
  assert.ok(avg(near) < avg(far));
});

test('hysteresis keeps the previous cell size near a threshold', () => {
  const base: PlanInput = { px: 0, pz: 0, rinChunks: 2, routChunks: 20, res: 4, quality: 12 };
  const first = plan(base);
  const prev = new Map(first.map((t) => [t.key, t.cell]));
  // Move a little: some chunk crosses a raw threshold but stays inside the hysteresis band.
  const moved = plan({ ...base, px: 9, pz: 5, prev });
  let kept = 0;
  for (const t of moved) {
    if (t.size !== 16) continue;
    const p = prev.get(t.key);
    if (p === undefined) continue;
    const raw = Math.min(16, cellSizeFor(t.dist, 4, 12));
    if (raw !== p) {
      assert.equal(t.cell, p, `tile ${t.key} flipped from ${p} to ${t.cell}`);
      kept++;
    }
  }
  assert.ok(kept > 0, 'expected at least one tile inside the hysteresis band');
  assert.ok(HYSTERESIS > 1 && HYSTERESIS < 1.3);
});

test('outer radius is capped at 32 chunks', () => {
  const tiles = plan({ px: 0, pz: 0, rinChunks: 0, routChunks: 100, res: 4, quality: 12 });
  for (const t of tiles) assert.ok(Math.max(Math.abs(t.x0), Math.abs(t.x0 + t.size)) <= 33 * 16);
});

test('planning yields for time slicing and quad estimates scale with quality', () => {
  const gen = planTiles({ px: 0, pz: 0, rinChunks: 8, routChunks: 32, res: 4, quality: 12 });
  let yields = 0;
  let r = gen.next();
  while (!r.done) {
    yields++;
    r = gen.next();
  }
  assert.ok(yields > 10);
  const lo = estimateQuads(plan({ px: 0, pz: 0, rinChunks: 8, routChunks: 32, res: 4, quality: 8 }));
  const hi = estimateQuads(plan({ px: 0, pz: 0, rinChunks: 8, routChunks: 32, res: 4, quality: 22 }));
  assert.ok(hi > lo * 2, `lo=${lo} hi=${hi}`);
});

test('chunk tiles just outside the real-terrain radius are marked conservative', () => {
  const tiles = plan({ px: 8, pz: 8, rinChunks: 5, routChunks: 20, res: 4, quality: 12, conservativeChunks: 2 });
  let marked = 0;
  for (const t of tiles) {
    const cx = t.x0 / 16;
    const cz = t.z0 / 16;
    const inBand = t.size === 16 && cx * cx + cz * cz <= 7 * 7;
    assert.equal(!!t.conservative, inBand, `tile ${t.key}`);
    if (inBand) marked++;
  }
  assert.ok(marked > 20);
});
