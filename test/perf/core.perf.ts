/**
 * Performance of the core interpreted by QuickJS (the engine Bedrock runs add-on scripts in): a player standing
 * still while the horizon is generated, then walking. Runs alone (`npm run test:perf`) so other test processes do
 * not compete for the CPU.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { getQuickJS } from 'quickjs-emscripten';

/** perf-entry's calibration workload on the development machine (ms, best of 5, measured after the run). */
const REFERENCE_CALIBRATION_MS = 100;

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
    // Steps are small: 99% finish within 3 ms. Isolated longer steps land on random jobs and ticks from run to run
    // (host scheduling noise: a constant 0.25 ms loop shows the same 10-20 ms outliers), so a few get an allowance;
    // a deterministic slow step repeats with every plan, mesh or batch (a plan that never yields: 35 steps > 10 ms).
    assert.ok(r.stepP99 <= 3 * slow, `99th percentile step ${r.stepP99} ms`);
    const over10 = (topSteps as number[]).filter((ms) => ms > 10 * slow).length;
    assert.ok(over10 <= 15, `${over10} of ${r.steps} steps over ${10 * slow} ms`);
    assert.ok(over20 <= 6, `${over20} of ${r.steps} steps over ${20 * slow} ms`);
    assert.ok(r.tickAvg <= 3 * slow, `per-tick housekeeping + spawning avg ${r.tickAvg} ms`);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
});
