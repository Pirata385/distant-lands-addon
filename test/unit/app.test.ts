import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../src/core/app';
import { FakeHost, FakePlayer } from '../fakes/host';
import { FOG_USER_ID } from '../../src/core/fog';
import { EFFECT_TOP } from '../../src/core/types';

function run(host: FakeHost, app: App, ticks: number, perTick?: (t: number) => void): void {
  for (let i = 0; i < ticks; i++) {
    host.advance();
    app.tick();
    const g = app.backgroundSlice();
    while (!g.next().done);
    perTick?.(i);
  }
}

function quadTarget(s: FakePlayer['spawned'][number]) {
  return { x: s.at.x + s.vars.ox, y: s.at.y + s.vars.oy, z: s.at.z + s.vars.oz };
}

function newApp(host: FakeHost): App {
  const app = new App(host);
  app.start();
  return app;
}

test('a joining player gets horizon fog and LOD quads outside the vanilla radius', () => {
  const host = new FakeHost();
  const p = host.addPlayer('alice', { x: 8, y: 90, z: 8 });
  const app = new App(host);
  app.settings.set('maxDistance', 16);
  app.start();
  run(host, app, 600);
  assert.deepEqual(p.commands.slice(0, 2), [`fog @s remove ${FOG_USER_ID}`, `fog @s push dl:horizon_16 ${FOG_USER_ID}`]);
  const tops = p.spawned.filter((s) => s.effect === EFFECT_TOP);
  assert.ok(tops.length > 200, `only ${tops.length} tops`);
  for (const s of p.spawned) {
    const q = quadTarget(s);
    const dcx = Math.floor(q.x / 16);
    const dcz = Math.floor(q.z / 16);
    assert.ok(dcx * dcx + dcz * dcz > 4 * 4, `quad in real terrain at chunk ${dcx},${dcz}`);
    assert.ok(dcx * dcx + dcz * dcz <= 17 * 17, 'quad beyond max distance');
    assert.ok(Math.hypot(s.at.x - 8, s.at.z - 8) <= 21, 'emitter near the player');
  }
});

test('nether players and players who disable LOD get vanilla fog and no quads', () => {
  const host = new FakeHost();
  const n = host.addPlayer('nether', { x: 0, y: 70, z: 0 }, host.nether);
  const o = host.addPlayer('over', { x: 0, y: 90, z: 0 });
  const app = newApp(host);
  run(host, app, 100);
  assert.equal(n.spawned.length, 0);
  assert.deepEqual(n.commands, [`fog @s remove ${FOG_USER_ID}`]);
  assert.ok(o.spawned.length > 0);
  app.settings.setPlayer('over', 'pEnabled', false);
  run(host, app, 5);
  const count = o.spawned.length;
  run(host, app, 200);
  assert.equal(o.spawned.length, count);
  assert.equal(o.commands[o.commands.length - 1], `fog @s remove ${FOG_USER_ID}`);
});

test('settings change mid generation cleans up', () => {
  const host = new FakeHost();
  host.addPlayer('alice', { x: 8, y: 90, z: 8 });
  const app = newApp(host);
  let sawArea = false;
  run(host, app, 400, () => {
    if (host.areas.size > 0) sawArea = true;
  });
  assert.ok(sawArea, 'generation used a ticking area');
  app.settings.set('genMode', 0);
  run(host, app, 1);
  assert.equal(host.areas.size, 0, 'areas removed when generation is turned off');
  const adds = host.overworld.commands.filter((c) => c.startsWith('tickingarea add')).length;
  run(host, app, 300);
  assert.equal(host.overworld.commands.filter((c) => c.startsWith('tickingarea add')).length, adds);
});

test('the spawn budget is shared between players', () => {
  const host = new FakeHost();
  const a = host.addPlayer('a', { x: 8, y: 90, z: 8 });
  const b = host.addPlayer('b', { x: 2000, y: 90, z: 8 });
  const app = newApp(host);
  app.settings.set('spawnsPerTick', 20);
  run(host, app, 400, () => {
    const t = host.tick;
    const n = a.spawned.filter((s) => s.tick === t).length + b.spawned.filter((s) => s.tick === t).length;
    assert.ok(n <= 20, `spawned ${n} in one tick`);
  });
  assert.ok(a.spawned.length > 0 && b.spawned.length > 0);
});

test('players that leave are forgotten and spawn errors never escape', () => {
  const host = new FakeHost();
  const a = host.addPlayer('a', { x: 8, y: 90, z: 8 });
  const app = newApp(host);
  run(host, app, 100);
  a.failSpawns = true;
  run(host, app, 50);
  a.valid = false;
  run(host, app, 40);
  assert.equal(app.playerCount, 0);
});

test('block changes trigger resampling of the chunk', () => {
  const host = new FakeHost();
  host.addPlayer('a', { x: 8, y: 90, z: 8 });
  const app = newApp(host);
  run(host, app, 200);
  const before = app.store.version(0, 1, 1);
  assert.ok(before > 0);
  app.onBlockChanged(0, 20, 20);
  assert.ok(app.store.isDirty(0, 1, 1));
  run(host, app, 100);
  assert.ok(!app.store.isDirty(0, 1, 1), 'resampled');
});

test('LOD data survives a world reload', () => {
  const host = new FakeHost();
  host.addPlayer('a', { x: 8, y: 90, z: 8 });
  const app = newApp(host);
  run(host, app, 400);
  app.shutdown();
  const keys = host.kv.keys().filter((k) => k.startsWith('dl:r:'));
  assert.ok(keys.length > 0, 'regions persisted');
  const app2 = new App(host);
  app2.start();
  assert.ok(app2.store.has(0, 6, 0), 'data available before any sampling');
});

test('LOD pauses while the player is deep underground', () => {
  const host = new FakeHost();
  const p = host.addPlayer('miner', { x: 8, y: 90, z: 8 });
  const app = newApp(host);
  run(host, app, 200);
  p.pos = { x: 8, y: 10, z: 8 };
  host.overworld.skyLight = () => 0;
  run(host, app, 40);
  const n = p.spawned.length;
  run(host, app, 200);
  assert.equal(p.spawned.length, n, 'no spawns underground');
  host.overworld.skyLight = () => 15;
  p.pos = { x: 8, y: 90, z: 8 };
  run(host, app, 400);
  assert.ok(p.spawned.length > n, 'resumes on the surface');
});
