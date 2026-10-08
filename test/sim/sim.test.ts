/**
 * End-to-end scenarios: the production behavior-pack bundle running against the fake Bedrock runtime.
 * Each scenario starts a fresh world and a freshly evaluated add-on.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld, ticks, fake, ui, coverage, overlapArtifacts, finish, FakePlayer } from './harness';

const warnings: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};
after(() => {
  console.warn = origWarn;
  finish();
});

function errorLogs(): string[] {
  return warnings.filter((w) => w.includes('error #') || w.includes('failed to start'));
}

async function world(opts: Parameters<typeof startWorld>[0] = {}): Promise<void> {
  warnings.length = 0;
  await startWorld(opts);
}

function healthy(p?: FakePlayer): void {
  assert.deepEqual(fake.uncaught, [], 'no uncaught exceptions');
  assert.deepEqual(errorLogs(), [], 'no logged errors');
  if (p) assert.equal(p.spawnFailures, 0, 'no particle spawn failures');
}

test('a stationary player gets a complete horizon without floating faces', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('alice', { x: 8, y: 100, z: 8 });
  fake.scriptEvent(undefined, 'dl:set', 'maxDistance=16');
  let maxPerTick = 0;
  await ticks(1600, () => {
    maxPerTick = Math.max(maxPerTick, p.spawnedThisTick);
  });
  const c = coverage(p, 6, 16);
  assert.ok(c.ratio >= 0.98, `coverage ${c.covered}/${c.ring}`);
  assert.equal(overlapArtifacts(p), 0);
  assert.ok(maxPerTick <= 60, `spawned ${maxPerTick} in one tick`);
  assert.deepEqual(p.fogStack, [{ fog: 'dl:horizon_16', id: 'dl_lod' }]);
  assert.ok(fake.maxAreas >= 1 && fake.maxAreas <= 1, `ticking areas ${fake.maxAreas}`);
  assert.equal(fake.areas.size, 0, 'all ticking areas released once the horizon is generated');
  for (const [k, v] of fake.world.props) if (typeof v === 'string') assert.ok(v.length <= 32767, k);
  healthy(p);
});

test('sprinting keeps the horizon ahead filled with almost no floating faces', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('runner', { x: 8, y: 100, z: 8 });
  fake.scriptEvent(undefined, 'dl:set', 'maxDistance=16');
  await ticks(1200);
  let worst = 0;
  let aheadSum = 0;
  let samples = 0;
  for (let s = 0; s < 6; s++) {
    await ticks(200, () => {
      p.location = { ...p.location, x: p.location.x + 0.28 };
      p.viewDirection = { x: 1, y: 0, z: 0 };
    });
    aheadSum += coverage(p, 7, 16, (dx) => dx > 0).ratio;
    samples++;
    worst = Math.max(worst, overlapArtifacts(p) / Math.max(1, p.particles.length));
  }
  assert.ok(aheadSum / samples >= 0.8, `ahead coverage ${aheadSum / samples}`);
  assert.ok(worst <= 0.02, `floating faces ${(worst * 100).toFixed(1)}%`);
  healthy(p);
});

test('fast elytra flight never errors and the horizon recovers after landing', async () => {
  await world({ viewRadius: 8 });
  const p = fake.join('glider', { x: 8, y: 200, z: 8 });
  fake.scriptEvent(undefined, 'dl:set', 'maxDistance=16');
  await ticks(400);
  p.isGliding = true;
  await ticks(600, () => {
    p.location = { ...p.location, z: p.location.z + 1.5 };
    p.viewDirection = { x: 0, y: -0.2, z: 1 };
  });
  p.isGliding = false;
  await ticks(2000);
  const c = coverage(p, 8, 16);
  assert.ok(c.ratio >= 0.95, `coverage after landing ${c.covered}/${c.ring}`);
  assert.deepEqual(fake.uncaught, []);
  assert.deepEqual(errorLogs(), []);
});

test('two players share the spawn budget and only receive their own LOD', async () => {
  await world({ viewRadius: 6 });
  const a = fake.join('a', { x: 8, y: 100, z: 8 });
  const b = fake.join('b', { x: 3000, y: 100, z: -500 });
  fake.scriptEvent(undefined, 'dl:set', 'maxDistance=12');
  await ticks(1200, () => {
    assert.ok(a.spawnedThisTick + b.spawnedThisTick <= 60, 'shared budget');
  });
  for (const [p, cx, cz] of [
    [a, 0, 0],
    [b, Math.floor(3000 / 16), Math.floor(-500 / 16)],
  ] as const) {
    assert.ok(p.particles.length > 500, `${p.name} has ${p.particles.length} faces`);
    for (const q of p.particles) {
      const dx = Math.floor(q.x / 16) - cx;
      const dz = Math.floor(q.z / 16) - cz;
      assert.ok(dx * dx + dz * dz <= 14 * 14, `${p.name} got a face ${dx},${dz} chunks away`);
    }
  }
  healthy(a);
  healthy(b);
});

test('the nether hides LOD and restores it on return', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('traveller', { x: 8, y: 100, z: 8 });
  await ticks(600);
  assert.ok(p.particles.length > 0);
  fake.changeDimension(p, 'nether', { x: 1, y: 70, z: 1 });
  await ticks(40);
  const spawned = p.spawnedTotal;
  await ticks(400);
  assert.equal(p.spawnedTotal, spawned, 'no LOD in the nether');
  assert.deepEqual(p.fogStack, [], 'vanilla fog in the nether');
  fake.changeDimension(p, 'overworld', { x: 8, y: 100, z: 8 });
  await ticks(400);
  assert.ok(p.spawnedTotal > spawned, 'LOD resumes in the overworld');
  assert.equal(p.fogStack.length, 1);
  healthy(p);
});

test('commands, script events and the menu change settings; non-operators cannot', async () => {
  await world({ viewRadius: 6 });
  const op = fake.join('op', { x: 8, y: 100, z: 8 });
  const guest = fake.join('guest', { x: 40, y: 100, z: 8 });
  guest.playerPermissionLevel = 1;
  assert.equal(fake.registry.commands[0].def.name, 'dl:horizon');
  assert.equal(fake.registry.commands[0].def.cheatsRequired, false);
  await ticks(20);
  fake.runCustomCommand(op, 'preset', 0);
  await ticks(20);
  assert.deepEqual(op.fogStack, [{ fog: 'dl:horizon_12', id: 'dl_lod' }], 'potato preset = 12 chunks');
  fake.scriptEvent(op, 'dl:set', 'maxDistance=20');
  await ticks(20);
  assert.deepEqual(op.fogStack, [{ fog: 'dl:horizon_20', id: 'dl_lod' }]);
  fake.runCustomCommand(guest, 'preset', 4);
  await ticks(20);
  assert.deepEqual(op.fogStack, [{ fog: 'dl:horizon_20', id: 'dl_lod' }], 'guest preset ignored');
  assert.ok(guest.messages.some((m: any) => m?.translate === 'dl.msg.op_only'));
  // Menu: main -> "Distance & quality" (4th button for operators) -> submit with distance 10.
  ui.answers.push({ selection: 3 });
  ui.answers.push((form) => {
    const values = form.controls.map((c: any) => {
      if (c.kind === 'slider') return c.label.translate === 'dl.setting.maxDistance' ? 10 : c.extra.defaultValue;
      if (c.kind === 'toggle') return c.extra?.defaultValue ?? false;
      if (c.kind === 'dropdown') return c.extra?.defaultValueIndex ?? 0;
      return undefined;
    });
    return { formValues: values };
  });
  fake.runCustomCommand(op, 'menu');
  await ticks(40);
  assert.equal(ui.shown[0].type, 'action');
  assert.equal(ui.shown[1].type, 'modal');
  assert.deepEqual(op.fogStack, [{ fog: 'dl:horizon_10', id: 'dl_lod' }]);
  // Personal toggle works for everyone.
  fake.runCustomCommand(guest, 'toggle');
  await ticks(10);
  assert.deepEqual(guest.fogStack, []);
  healthy(op);
});

test('a busy player (chat open) gets the menu once the chat closes', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('chatty', { x: 8, y: 100, z: 8 });
  ui.answers.push({ canceled: true, reason: 'UserBusy' as any });
  ui.answers.push({ canceled: true, reason: 'UserBusy' as any });
  ui.answers.push({ canceled: true });
  fake.runCustomCommand(p, 'menu');
  await ticks(40);
  assert.equal(ui.shown.length, 3, 'retried twice while busy');
  healthy(p);
});

test('using the Horizon Lens opens the menu and the self-test draws its grid', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('lens', { x: 8, y: 100, z: 8 });
  await ticks(20);
  fake.world.afterEvents.itemUse.fire({ source: p, itemStack: { typeId: 'dl:horizon_lens' } });
  await ticks(5);
  assert.equal(ui.shown.length, 1);
  const before = p.spawnedTotal;
  fake.runCustomCommand(p, 'selftest');
  await ticks(2);
  assert.ok(p.spawnedTotal - before >= 32, `self-test spawned ${p.spawnedTotal - before}`);
  assert.ok(p.messages.some((m: any) => m?.translate === 'dl.msg.selftest'));
  healthy(p);
});

test('the self-test grid stays visible for a player standing on the ground', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('ground', { x: 8, y: 63, z: 8 }); // on the ground block at y=62
  await ticks(20);
  const t0 = fake.tick;
  fake.runCustomCommand(p, 'selftest');
  await ticks(2);
  const grid = p.particles.filter((q) => q.born >= t0 && Math.hypot(q.x - 8, q.z - 8) < 48);
  assert.equal(grid.length, 32, `${grid.length} of 32 test faces survived the self-cull`);
  healthy(p);
});

test('LOD data survives a world reload and renders without regenerating', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('saver', { x: 8, y: 100, z: 8 });
  fake.scriptEvent(undefined, 'dl:set', 'maxDistance=14');
  await ticks(1600);
  fake.scriptEvent(undefined, 'dl:set', 'genMode=0');
  await ticks(80);
  const regions = [...fake.world.props.keys()].filter((k) => k.startsWith('dl:r:'));
  assert.ok(regions.length > 4, `regions saved: ${regions.length}`);
  // Reload: same world properties, fresh runtime and add-on.
  await world({ viewRadius: 6, keepWorldProps: true });
  const q = fake.join('saver', { x: 8, y: 100, z: 8 });
  await ticks(400);
  const c = coverage(q, 6, 14);
  assert.ok(c.ratio >= 0.95, `coverage from storage ${c.covered}/${c.ring}`);
  assert.equal(fake.areaAdds, 0, 'nothing generated after reload (data came from storage)');
  healthy(q);
});

test('leaving players release generation and stale ticking areas are removed at startup', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('quitter', { x: 8, y: 100, z: 8 });
  await ticks(200);
  assert.ok(fake.areas.size > 0, 'generating');
  fake.leave(p);
  await ticks(800);
  assert.equal(fake.areas.size, 0, 'areas released after the player left');
  // A crash left an area behind: the next start removes it.
  fake.areas.set('dl_gen_4', { dim: fake.dimensions.get('overworld')!, x1: 0, z1: 0, x2: 15, z2: 15, since: 0 });
  await world({ viewRadius: 6, keepWorldProps: true });
  assert.ok(!fake.areas.has('dl_gen_4'));
  assert.deepEqual(fake.uncaught, []);
});

test('night time LOD is darker and follows the day cycle', async () => {
  await world({ viewRadius: 6 });
  fake.timeOfDay = 17000;
  const p = fake.join('owl', { x: 8, y: 100, z: 8 });
  await ticks(600);
  const night = p.particles.slice(-50).map((q) => q.vars.get('variable.l0')!);
  assert.ok(Math.max(...night) < 0.45, `night brightness ${Math.max(...night)}`);
  fake.timeOfDay = 6000;
  await ticks(600);
  const day = p.particles.slice(-50).map((q) => q.vars.get('variable.l0')!);
  assert.ok(Math.min(...day) > 0.9, `day brightness ${Math.min(...day)}`);
  healthy(p);
});

test('block edits reach the LOD once the area is seen again', async () => {
  await world({ viewRadius: 6 });
  const p = fake.join('builder', { x: 8, y: 100, z: 8 });
  await ticks(400);
  const before = fake.stats.topmost;
  fake.world.afterEvents.playerBreakBlock.fire({ block: { dimension: p.dimension, location: { x: 20, y: 64, z: 20 } }, player: p });
  await ticks(100);
  assert.ok(fake.stats.topmost > before, 'chunk resampled');
  healthy(p);
});
