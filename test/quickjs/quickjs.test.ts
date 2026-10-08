/**
 * QuickJS checks: Bedrock runs add-on scripts in QuickJS, not V8.
 *  1. The shipped bundle parses and its top-level code runs as an ES module in QuickJS.
 *  2. The core (planning, meshing, sampling, generation, spawning) runs inside QuickJS within the time budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';
// @ts-ignore - plain ESM build script
import { build } from '../../scripts/build.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
/** perf-entry's calibration workload on the development machine (ms, best of 5). */
const REFERENCE_CALIBRATION_MS = 76;

/** Minimal module stubs: enough for the bundle's top-level code (subscriptions and timers). */
const SERVER_STUB = `
const signal = () => ({ subscribe(cb) { return cb; }, unsubscribe() {} });
export const system = {
  beforeEvents: { startup: signal(), shutdown: signal() },
  afterEvents: { scriptEventReceive: signal() },
  run() { return 0; }, runTimeout() { return 0; }, runInterval() { return 0; }, runJob() { return 0; },
  currentTick: 0,
};
export const world = { afterEvents: new Proxy({}, { get: () => signal() }) };
export class Player {}
export class MolangVariableMap { setFloat() {} }
export const PlayerPermissionLevel = { Visitor: 0, Member: 1, Operator: 2, Custom: 3 };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 };
export const CustomCommandParamType = { Enum: 'Enum', Integer: 'Integer' };
export const CustomCommandStatus = { Success: 0, Failure: 1 };
export const TintMethod = { None: 'None' };
`;
const UI_STUB = `
export class ActionFormData {} export class ModalFormData {} export class MessageFormData {}
export const FormCancelationReason = { UserBusy: 'UserBusy', UserClosed: 'UserClosed' };
`;

test('the shipped bundle loads as an ES module in QuickJS', async (t) => {
  const base = join(ROOT, 'test-output');
  mkdirSync(base, { recursive: true });
  const outDir = mkdtempSync(join(base, 'qjs-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const r = await build({ outDir });
  const source = readFileSync(join(r.bpDir, 'scripts', 'main.js'), 'utf8');
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(256 * 1024 * 1024);
  runtime.setModuleLoader((name) => {
    if (name === '@minecraft/server') return SERVER_STUB;
    if (name === '@minecraft/server-ui') return UI_STUB;
    throw new Error(`unexpected import ${name}`);
  });
  const vm = runtime.newContext();
  try {
    const result = vm.evalCode(source, 'main.js', { type: 'module' });
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      assert.fail(`QuickJS rejected the bundle: ${JSON.stringify(err)}`);
    }
    result.value.dispose();
  } finally {
    vm.dispose();
    runtime.dispose();
  }
});

test('the core stays within its time budget when interpreted by QuickJS', async () => {
  const out = await esbuild({
    entryPoints: [join(import.meta.dirname, 'perf-entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    platform: 'neutral',
    write: false,
    logLevel: 'error',
  });
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(512 * 1024 * 1024);
  const vm = runtime.newContext();
  try {
    vm.unwrapResult(vm.evalCode('globalThis.__ticks = 1200;')).dispose();
    const res = vm.evalCode(out.outputFiles[0].text, 'perf.js');
    if (res.error) {
      const err = vm.dump(res.error);
      res.error.dispose();
      assert.fail(`perf run failed in QuickJS: ${JSON.stringify(err)}`);
    }
    res.value.dispose();
    const r = JSON.parse(vm.dump(vm.unwrapResult(vm.evalCode('globalThis.__result'))));
    // Limits are in development-machine milliseconds; slower machines (CI) get proportionally more time.
    const slow = Math.min(4, Math.max(1, r.calibrationMs / REFERENCE_CALIBRATION_MS));
    const { topSteps, ...summary } = r;
    const over20 = (topSteps as number[]).filter((ms) => ms > 20 * slow).length;
    console.log('QuickJS perf', JSON.stringify({ ...summary, slow, over20 }));
    assert.ok(r.quads > 1000, `LOD built in QuickJS (${r.quads} quads)`);
    assert.ok(r.generated + r.sampled > 300, 'terrain acquired');
    // Background work is sliced to the budget; one step may finish over it but never by much.
    assert.ok(r.bgAvg <= r.budget + 1.5 * slow, `background avg ${r.bgAvg} ms`);
    // Steps are small: 99.9% finish within 5 ms. Isolated longer steps land on random jobs and ticks from run to
    // run (host scheduling noise: a constant 0.25 ms loop shows the same 10-20 ms outliers), so they get an
    // allowance. A deterministic slow step would repeat with every plan, mesh or batch and exceed it.
    assert.ok(r.stepP999 <= 5 * slow, `99.9th percentile step ${r.stepP999} ms`);
    assert.ok(over20 <= Math.ceil(r.steps * 0.0005), `${over20} of ${r.steps} steps over ${20 * slow} ms`);
    assert.ok(r.tickAvg <= 3 * slow, `per-tick housekeeping + spawning avg ${r.tickAvg} ms`);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
});
