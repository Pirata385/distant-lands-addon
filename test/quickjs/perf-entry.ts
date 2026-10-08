/**
 * Bundled to an IIFE and executed inside QuickJS (the interpreter Bedrock uses for scripts) to measure the cost of
 * the real core code: a player standing still while the horizon is generated, then walking.
 */
import { App } from '../../src/core/app';
import { FakeHost } from '../fakes/host';

class RealClockHost extends FakeHost {
  override clock(): number {
    return Date.now();
  }
}

declare const globalThis: { __result?: string; __ticks?: number };

const host = new RealClockHost();
host.viewRadius = 8;
const p = host.addPlayer('perf', { x: 8, y: 100, z: 8 });
// In the game, spawned particles and block data live in native memory, not on the script heap. Keep the fake's own
// bookkeeping small so QuickJS GC pauses reflect the add-on's objects rather than the test scaffolding.
p.record = false;
p.dim.cacheLimit = 4096;
const app = new App(host);
app.settings.set('maxDistance', 24);
app.start();

const ticks = globalThis.__ticks ?? 1200;
const tickMs: number[] = [];
const bgMs: number[] = [];
const stepMs: number[] = [];
app.scheduler.onStep = (_name, ms) => stepMs.push(ms);
for (let i = 0; i < ticks; i++) {
  host.advance(0);
  if (i > ticks / 2) p.pos = { x: p.pos.x + 0.28, y: p.pos.y, z: p.pos.z };
  const t0 = Date.now();
  app.tick();
  const t1 = Date.now();
  const g = app.backgroundSlice();
  while (!g.next().done);
  const t2 = Date.now();
  tickMs.push(t1 - t0);
  bgMs.push(t2 - t1);
}

const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const max = (a: number[]) => a.reduce((m, v) => (v > m ? v : m), 0);
const sorted = stepMs.slice().sort((a, b) => a - b);
const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const over = (ms: number) => stepMs.filter((v) => v > ms).length;
const st = app.stats('perf');
globalThis.__result = JSON.stringify({
  ticks,
  tickAvg: avg(tickMs),
  tickMax: max(tickMs),
  bgAvg: avg(bgMs),
  bgMax: max(bgMs),
  steps: stepMs.length,
  stepP99: pct(0.99),
  stepP999: pct(0.999),
  stepsOver10: over(10),
  stepsOver20: over(20),
  longestStep: max(stepMs),
  totalAvg: avg(tickMs.map((v, i) => v + bgMs[i])),
  quads: st?.quads,
  generated: st?.generated,
  sampled: st?.sampled,
  spawned: p.spawnCount,
  budget: app.settings.num('budgetMs'),
  maxStepMs: Object.fromEntries(app.scheduler.maxStepMs),
  tickSections: Object.fromEntries(app.profile),
});
