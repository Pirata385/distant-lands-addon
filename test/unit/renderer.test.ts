import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayerView, ParticleSink, SpawnVars, ViewParams, EMIT_DISTANCE, LIFE_MARGIN } from '../../src/core/renderer';
import { skyLight, lightParams } from '../../src/core/lighting';
import { QUAD_STRIDE, K_TOP, K_WALL } from '../../src/core/mesher';
import type { Tile } from '../../src/core/planner';
import type { Vec3 } from '../../src/core/types';

interface Spawned {
  t: number;
  kind: number;
  emitter: Vec3;
  vars: SpawnVars;
}

class RecordingSink implements ParticleSink {
  spawned: Spawned[] = [];
  now = 0;
  failing = false;
  spawn(kind: number, emitter: Vec3, vars: SpawnVars): void {
    if (this.failing) throw new Error('LocationInUnloadedChunkError');
    this.spawned.push({ t: this.now, kind, emitter: { ...emitter }, vars: { ...vars } });
  }
}

function tileAt(x0: number, z0: number): Tile {
  return { key: `${x0},${z0},16`, x0, z0, size: 16, cell: 16, dist: Math.hypot(x0 + 8, z0 + 8) };
}

/** One top + one wall per tile (tile-local x/z, like the mesher). */
function meshFor(_t: Tile): Float32Array {
  const q = new Float32Array(QUAD_STRIDE * 2);
  q.set([K_TOP, 8, 70, 8, 8, 8, 0.4, 0.6, 0.3, 3], 0);
  q.set([K_WALL, 8, 66, 8, 8, 4, 0.3, 0.4, 0.2, 3], QUAD_STRIDE);
  return q;
}

function params(over: Partial<ViewParams> = {}): ViewParams {
  return {
    eye: { x: 0, y: 72, z: 0 },
    dir: { x: 0, y: 0, z: 1 },
    minY: -64,
    maxY: 320,
    refresh: 15,
    transitions: true,
    aerial: 0,
    fadeEnd: 512,
    l0: 1,
    dl: 0,
    share: 60 * 20,
    ...over,
  };
}

function ring(n: number, radius: number): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    tiles.push(tileAt(Math.round((Math.cos(a) * radius) / 16) * 16 + i * 0, Math.round((Math.sin(a) * radius) / 16) * 16));
  }
  const uniq = new Map(tiles.map((t) => [t.key, t]));
  return [...uniq.values()];
}

function setup(view: PlayerView, tiles: Tile[], p: ViewParams): void {
  view.setPlan(tiles, (t) => `sig${t.cell}`, p);
  for (;;) {
    const s = view.nextToMesh();
    if (!s) break;
    view.setMesh(s, meshFor(s.tile), s.wantedSig);
  }
}

function run(view: PlayerView, sink: RecordingSink, p: ViewParams, seconds: number, budget: number, from = 0): void {
  for (let tick = 0; tick < seconds * 20; tick++) {
    const now = from + tick / 20;
    sink.now = now;
    const n = view.pump(now, budget, sink, p);
    assert.ok(n <= budget, `spawned ${n} > budget ${budget}`);
  }
}

test('no tile goes dark between refreshes under nominal load', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params();
  const tiles = ring(200, 300);
  setup(view, tiles, p);
  run(view, sink, p, 90, 20);
  const byTile = new Map<string, Spawned[]>();
  for (const s of sink.spawned.filter((s) => s.kind === K_TOP)) {
    const key = `${Math.floor((s.emitter.x + s.vars.ox) / 16) * 16},${Math.floor((s.emitter.z + s.vars.oz) / 16) * 16}`;
    const list = byTile.get(key) ?? [];
    list.push(s);
    byTile.set(key, list);
  }
  assert.equal(byTile.size, tiles.length);
  for (const [key, list] of byTile) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      assert.ok(list[i].t - prev.t < prev.vars.life, `${key} gap ${list[i].t - prev.t} >= life ${prev.vars.life}`);
    }
    assert.ok(90 - list[list.length - 1].t < list[list.length - 1].vars.life, `${key} expired at the end`);
  }
});

test('emitters stay near the eye, inside world height, and offsets reach the quad', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ eye: { x: 10, y: 318, z: -5 } });
  setup(view, [tileAt(320, 0), tileAt(-400, 160)], p);
  run(view, sink, p, 1, 50);
  assert.ok(sink.spawned.length === 4);
  for (const s of sink.spawned) {
    const d = Math.hypot(s.emitter.x - 10, s.emitter.y - 318, s.emitter.z + 5);
    assert.ok(d <= EMIT_DISTANCE + 1e-6, `emitter ${d} blocks away`);
    assert.ok(s.emitter.y <= 319 && s.emitter.y >= -63);
  }
  const top = sink.spawned.find((s) => s.kind === K_TOP)!;
  const qx = top.emitter.x + top.vars.ox;
  assert.ok(qx === 328 || qx === -392);
});

test('tiles in front of the player and nearer tiles are spawned first', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ dir: { x: 1, y: 0, z: 0 } });
  const front = tileAt(304, 0);
  const behind = tileAt(-320, 0);
  const near = tileAt(160, 0);
  setup(view, [behind, front, near], p);
  run(view, sink, p, 1, 1);
  const order = sink.spawned.filter((s) => s.kind === K_TOP).map((s) => Math.round(s.emitter.x + s.vars.ox));
  assert.deepEqual(order, [168, 312, -312]);
});

test('skips spawning when host throws unloaded and resumes without losing quads', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params();
  setup(view, [tileAt(320, 0)], p);
  sink.failing = true;
  assert.equal(view.pump(0, 10, sink, p), 0);
  sink.failing = false;
  assert.equal(view.pump(0.05, 10, sink, p), 2);
});

test('a teleport while a tile is half-spawned moves the emitter with the player (no stuck spawning)', () => {
  // Spawning only works near the player (like spawnParticle in loaded chunks).
  class NearSink extends RecordingSink {
    centre: Vec3 = { x: 0, y: 72, z: 0 };
    override spawn(kind: number, emitter: Vec3, vars: SpawnVars): void {
      if (Math.hypot(emitter.x - this.centre.x, emitter.z - this.centre.z) > 48) throw new Error('LocationInUnloadedChunkError');
      super.spawn(kind, emitter, vars);
    }
  }
  const view = new PlayerView();
  const sink = new NearSink();
  const tile = tileAt(320, 0);
  const quads = new Float32Array(QUAD_STRIDE * 12);
  for (let i = 0; i < 12; i++) quads.set([K_TOP, 1 + i, 70, 8, 0.5, 0.5, 0.4, 0.6, 0.3, 3], i * QUAD_STRIDE);
  let p = params();
  view.setPlan([tile], () => 'sig', p);
  view.setMesh(view.nextToMesh()!, quads, 'sig');
  assert.equal(view.pump(0, 4, sink, p), 4);

  // Teleport 600 blocks: the old emitter position is no longer loaded, the tile is still in the plan.
  p = params({ eye: { x: 600, y: 72, z: 0 } });
  sink.centre = { x: 600, y: 72, z: 0 };
  let spawned = 0;
  for (let tick = 1; tick <= 4; tick++) spawned += view.pump(tick / 20, 4, sink, p);
  assert.equal(spawned, 8, 'the rest of the tile is spawned from an emitter near the new position');
  for (const s of sink.spawned.slice(4)) {
    assert.ok(Math.abs(s.emitter.x - 600) <= EMIT_DISTANCE + 1, `emitter at ${s.emitter.x}`);
  }
  const xs = sink.spawned.map((s) => Math.round(s.emitter.x + s.vars.ox)).sort((a, b) => a - b);
  assert.deepEqual(xs, Array.from({ length: 12 }, (_, i) => 321 + i), 'every quad lands at its world position');
});

test('a remeshed tile keeps its refresh deadline while new tiles keep the spawn queue busy', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params();
  const a = tileAt(-960, 0); // behind the player: last in the spawn queue
  setup(view, [a], p);
  run(view, sink, p, 1, 10);
  const many: Tile[] = []; // 1600 new tiles in front of the player: 3200 faces, 160 s at one face per tick
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) many.push(tileAt(-320 + i * 16, 96 + j * 16));
  view.setPlan([a, ...many], (t) => (t.key === a.key ? 'sig-new' : 'sig16'), p);
  for (;;) {
    const s = view.nextToMesh();
    if (!s) break;
    view.setMesh(s, meshFor(s.tile), s.wantedSig); // `a` gets a new mesh
  }
  run(view, sink, p, 30, 1, 1); // one face per tick: the new tiles alone need minutes
  const tops = sink.spawned.filter((x) => x.kind === K_TOP && Math.round(x.emitter.x + x.vars.ox) === -952);
  assert.ok(tops.length >= 2, `a spawned ${tops.length} times`);
  assert.ok(tops[1].t <= tops[0].t + tops[0].vars.life, `respawned at ${tops[1].t}, faces expired at ${tops[0].t + tops[0].vars.life}`);
});

test('lifetimes stretch when the spawn budget cannot keep up', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ share: 20 });
  setup(view, ring(400, 400), p);
  run(view, sink, p, 30, 1);
  const lives = sink.spawned.map((s) => s.vars.life);
  assert.ok(Math.max(...lives) > p.refresh + LIFE_MARGIN, `max life ${Math.max(...lives)}`);
});

test('removed tiles are not refreshed and changed tiles grow in again', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params();
  const a = tileAt(320, 0);
  const b = tileAt(-320, 0);
  setup(view, [a, b], p);
  run(view, sink, p, 1, 10);
  assert.ok(sink.spawned.every((s) => s.vars.grow > 0), 'first spawn grows in');
  sink.spawned = [];
  // Drop b, change a's signature.
  view.setPlan([{ ...a, cell: 8 }], (t) => `sig${t.cell}`, p);
  const s = view.nextToMesh()!;
  assert.equal(s.tile.key, a.key);
  view.setMesh(s, meshFor(a), s.wantedSig);
  assert.equal(view.nextToMesh(), undefined);
  run(view, sink, p, 40, 10, 1);
  assert.ok(sink.spawned.length > 0);
  assert.ok(sink.spawned.every((x) => Math.floor((x.emitter.x + x.vars.ox) / 16) * 16 === 320), 'only tile a');
  assert.ok(sink.spawned[0].vars.grow > 0, 'changed tile grows in');
  assert.ok(sink.spawned.slice(2).every((x) => x.vars.grow === 0), 'refreshes do not animate');
});

test('aerial perspective tints distant quads toward the sky', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ aerial: 1, fadeEnd: 400 });
  setup(view, [tileAt(32, 0), tileAt(384, 0)], p);
  run(view, sink, p, 1, 10);
  const near = sink.spawned.find((s) => s.kind === K_TOP && s.emitter.x + s.vars.ox < 100)!;
  const far = sink.spawned.find((s) => s.kind === K_TOP && s.emitter.x + s.vars.ox > 300)!;
  assert.ok(far.vars.bl > near.vars.bl, 'far quad is bluer');
});

test('sky light follows the day cycle', () => {
  assert.ok(skyLight(6000, 0, 0) > 0.95, 'noon');
  assert.ok(skyLight(18000, 0, 0) < 0.35, 'midnight');
  assert.ok(skyLight(6000, 1, 0) < skyLight(6000, 0, 0), 'rain darkens');
  const dusk = lightParams({ timeOfDay: 12000, rain: 0, thunder: 0, dayCycle: true, enabled: true });
  assert.ok(dusk.dl < 0, 'brightness falls at dusk');
  const frozen = lightParams({ timeOfDay: 12000, rain: 0, thunder: 0, dayCycle: false, enabled: true });
  assert.equal(frozen.dl, 0);
  const off = lightParams({ timeOfDay: 18000, rain: 0, thunder: 0, dayCycle: true, enabled: false });
  assert.deepEqual(off, { l0: 1, dl: 0 });
});

test('tiles the player is approaching get lifetimes that end when real terrain arrives', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ velocity: { x: 10, y: 0, z: 0 }, innerRadius: 96 });
  setup(view, [tileAt(160, 0), tileAt(-176, 0)], p);
  run(view, sink, p, 1, 10);
  const front = sink.spawned.find((s) => s.emitter.x + s.vars.ox > 0)!;
  const back = sink.spawned.find((s) => s.emitter.x + s.vars.ox < 0)!;
  // Front tile's nearest edge is at x=160: 64 blocks beyond the 96-block radius at 10 b/s -> ~6.4 s.
  assert.ok(front.vars.life < 8 && front.vars.life >= 3, `front life ${front.vars.life}`);
  assert.equal(back.vars.life, p.refresh + LIFE_MARGIN);
});

test('walls are moved to the cell edge facing the player (no gap behind the step)', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ eye: { x: 0, y: 150, z: 0 } });
  const t = tileAt(320, 0); // wall quad at tile-local (8, 66, 8), half width 8 -> cell spans x 320..336
  setup(view, [t], p);
  run(view, sink, p, 1, 10);
  const wall = sink.spawned.find((s) => s.kind === K_WALL)!;
  const wx = wall.emitter.x + wall.vars.ox;
  const wz = wall.emitter.z + wall.vars.oz;
  assert.ok(Math.abs(wx - 320.5) < 0.6, `wall x ${wx} should sit at the near (west) edge`);
  assert.ok(Math.abs(wz - 8) < 1, `wall z ${wz}`);
  const top = sink.spawned.find((s) => s.kind === K_TOP)!;
  assert.equal(top.emitter.x + top.vars.ox, 328, 'tops stay centred');
});

test('walls of conservative tiles also stand at the edge facing the player, as wide as the cell looks', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ eye: { x: 0, y: 150, z: 0 } });
  const t = { ...tileAt(320, 320), conservative: true }; // seen along the diagonal
  setup(view, [t], p);
  run(view, sink, p, 1, 10);
  const wall = sink.spawned.find((s) => s.kind === K_WALL)!;
  const wx = wall.emitter.x + wall.vars.ox;
  const wz = wall.emitter.z + wall.vars.oz;
  assert.ok(wx < 328 && wz < 328, `wall at ${wx},${wz} moved toward the player`);
  assert.ok(Math.abs(wall.vars.a - 8 * Math.SQRT2) < 0.01, `half width ${wall.vars.a}: a square seen at 45° is √2 wider`);
});

test('over real terrain walls stay centred and as wide as the cell, so they self-cull inside its blocks', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ eye: { x: 0, y: 150, z: 0 }, innerRadius: 30 * 16 }); // the tile's chunk is loaded
  const t = { ...tileAt(320, 320), conservative: true };
  setup(view, [t], p);
  run(view, sink, p, 1, 10);
  const wall = sink.spawned.find((s) => s.kind === K_WALL)!;
  assert.equal(wall.emitter.x + wall.vars.ox, 328);
  assert.equal(wall.emitter.z + wall.vars.oz, 328);
  assert.equal(wall.vars.a, 8);
});

test('plans can be built incrementally while the old plan keeps rendering', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params();
  const a = tileAt(320, 0);
  const b = tileAt(-320, 0);
  setup(view, [a], p);
  run(view, sink, p, 1, 10);
  view.beginPlan(p);
  view.addPlanTile(b, 'sig16');
  // Still rendering the old plan until commit.
  assert.deepEqual([...view.states.keys()], [a.key]);
  view.commitPlan();
  assert.deepEqual([...view.states.keys()], [b.key]);
  assert.equal(view.nextToMesh()!.tile.key, b.key);
  view.beginPlan(p);
  view.addPlanTile(a, 'sig16');
  view.abortPlan();
  assert.deepEqual([...view.states.keys()], [b.key], 'aborted plans change nothing');
  view.beginPlan(p);
  assert.equal(view.addPlanTile(a, 'sig16'), true);
  view.reset();
  assert.equal(view.addPlanTile(b, 'sig16'), false, 'a reset view refuses tiles of the plan that was in progress');
  view.commitPlan();
  assert.equal(view.states.size, 0);
});

test('mesh queue is ordered nearest-first without a comparator sort', () => {
  const view = new PlayerView();
  const p = params({ dir: { x: 1, y: 0, z: 0 } });
  const tiles = [tileAt(480, 0), tileAt(160, 0), tileAt(-160, 0), tileAt(320, 0)];
  view.setPlan(tiles, () => 'sig', p);
  const order: number[] = [];
  for (let s = view.nextToMesh(); s; s = view.nextToMesh()) order.push(s.tile.x0);
  // Behind the player counts 2.5x: 152 blocks behind (score ~380) beats 488 blocks ahead.
  assert.deepEqual(order, [160, 320, -160, 480]);
});
