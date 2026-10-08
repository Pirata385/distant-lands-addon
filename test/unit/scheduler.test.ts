import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/core/scheduler';
import { fogEnd, fogIdFor, FogManager, FOG_DISTANCES, FOG_USER_ID } from '../../src/core/fog';
import { formatHud } from '../../src/core/hud';
import type { HostPlayer } from '../../src/core/types';

function clock(step = 0.1) {
  let t = 0;
  return () => (t += step);
}

/** Simulated time that only advances while jobs do work (clock reads are free). */
function workClock() {
  const c = { now: 0, read: () => c.now };
  return c;
}

function endless(counter: { n: number }, onStep?: () => void) {
  return {
    next: () =>
      (function* () {
        for (;;) {
          counter.n++;
          onStep?.();
          yield;
        }
      })(),
  };
}

test('runFor stops at the time budget', () => {
  const c = workClock();
  const s = new Scheduler(c.read);
  const a = { n: 0 };
  s.add('a', endless(a, () => (c.now += 0.1)));
  s.runFor(3);
  assert.ok(a.n >= 29 && a.n <= 31, `steps ${a.n}`);
  assert.ok((s.maxStepMs.get('a') ?? 0) > 0.09, 'step time is profiled');
});

test('weighted round robin gives every busy job a share', () => {
  const s = new Scheduler(clock(0.01));
  const a = { n: 0 };
  const b = { n: 0 };
  s.add('a', endless(a), 3);
  s.add('b', endless(b), 1);
  s.runFor(10);
  assert.ok(a.n > 0 && b.n > 0);
  assert.ok(Math.abs(a.n / b.n - 3) < 0.2, `ratio ${a.n / b.n}`);
});

test('idle jobs are skipped and the scheduler reports idleness', () => {
  const s = new Scheduler(clock());
  let units = 0;
  s.add('once', {
    next: () =>
      units < 2
        ? (function* () {
            units++;
            yield;
            return true;
          })()
        : undefined,
  });
  s.add('never', { next: () => undefined });
  let steps = 0;
  while (s.step()) steps++;
  assert.equal(units, 2);
  assert.equal(steps, 4);
});

test('slice yields between steps', () => {
  const c = workClock();
  const s = new Scheduler(c.read);
  const a = { n: 0 };
  s.add('a', endless(a, () => (c.now += 0.5)));
  const g = s.slice(2);
  let yields = 0;
  while (!g.next().done) yields++;
  assert.ok(yields >= 3 && yields <= 5, `yields ${yields}`);
});

test('fog ids map the drawn LOD edge, mode and dimension', () => {
  assert.equal(fogIdFor(0, 24, 0), 'dl:horizon_24');
  assert.equal(fogIdFor(0, 23.7, 0), 'dl:horizon_23', 'rounded down: the fog must be complete before the edge');
  assert.equal(fogIdFor(0, 5, 0), 'dl:horizon_6');
  assert.equal(fogIdFor(0, 40, 0), 'dl:horizon_32');
  assert.equal(fogIdFor(0, 24, 2), 'dl:haze_24');
  assert.equal(fogIdFor(2, 24, 0), 'dl:end_24');
  assert.equal(fogIdFor(1, 24, 0), undefined);
  assert.equal(fogIdFor(0, 24, 1), undefined);
  assert.equal(fogIdFor(0, 0, 0), undefined, 'no LOD drawn: vanilla fog');
  assert.deepEqual(FOG_DISTANCES, Array.from({ length: 27 }, (_, i) => i + 6));
  for (const d of FOG_DISTANCES) assert.ok(fogEnd(d) <= d * 16 - 20, 'fog complete before the stair-stepped LOD edge');
});

test('fog manager removes stale fog once and only issues commands on change', () => {
  const cmds: string[] = [];
  const p = { id: 'p', runCommand: (c: string) => (cmds.push(c), true) } as unknown as HostPlayer;
  const fog = new FogManager();
  fog.apply(p, 'dl:horizon_24');
  assert.deepEqual(cmds, [`fog @s remove ${FOG_USER_ID}`, `fog @s push dl:horizon_24 ${FOG_USER_ID}`]);
  fog.apply(p, 'dl:horizon_24');
  assert.equal(cmds.length, 2);
  fog.apply(p, 'dl:horizon_16');
  assert.deepEqual(cmds.slice(2), [`fog @s remove ${FOG_USER_ID}`, `fog @s push dl:horizon_16 ${FOG_USER_ID}`]);
  fog.apply(p, undefined);
  assert.deepEqual(cmds.slice(4), [`fog @s remove ${FOG_USER_ID}`]);
  fog.apply(p, undefined);
  assert.equal(cmds.length, 5);
  fog.forget('p');
  fog.apply(p, undefined);
  assert.equal(cmds.length, 6, 'a forgotten player gets the stale-fog cleanup again');
});

test('hud shows the key numbers', () => {
  const text = formatHud({ quads: 3412, tiles: 1204, spawnRate: 210, cached: 2840, genQueue: 3, ms: 1.84, radius: 8, distance: 24, refresh: 15, paused: false });
  for (const s of ['3412', '1204', '2840', '1.8', '8', '24']) assert.ok(text.includes(s), `${s} in ${text}`);
});
