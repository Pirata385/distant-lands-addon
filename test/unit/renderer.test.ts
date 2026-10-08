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

test('walls of conservative tiles stay centred (they must sit under the real surface)', () => {
  const view = new PlayerView();
  const sink = new RecordingSink();
  const p = params({ eye: { x: 0, y: 150, z: 0 } });
  const t = { ...tileAt(320, 0), conservative: true };
  setup(view, [t], p);
  run(view, sink, p, 1, 10);
  const wall = sink.spawned.find((s) => s.kind === K_WALL)!;
  assert.equal(wall.emitter.x + wall.vars.ox, 328);
});
