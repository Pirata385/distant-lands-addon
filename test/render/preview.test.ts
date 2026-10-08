/** Checks the rendered LOD band for holes and floating faces; previews go to test-output/previews/. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scene, finish } from './scene';

after(() => finish());

for (const [name, yaw, pitch, lift, settings] of [
  ['north-ground', 0, -0.06, 2, []],
  ['east-hill', Math.PI / 2, -0.1, 12, []],
  ['southwest-high', (-3 * Math.PI) / 4, -0.25, 60, []],
  ['coarse-low', Math.PI, -0.2, 40, ['sampleRes=2', 'quality=0']],
  ['fine-ultra', -Math.PI / 2, -0.2, 40, ['sampleRes=0', 'quality=3', 'maxQuads=16000']],
] as const) {
  test(`rendered LOD band has no holes or floating faces (${name})`, async () => {
    const m = await scene(name, yaw, pitch, lift, [...settings]);
    console.log(name, JSON.stringify(m));
    assert.ok(m.band > 500, `band pixels ${m.band}`);
    assert.ok(m.holes / m.band < 0.01, `holes ${((m.holes / m.band) * 100).toFixed(2)}%`);
    assert.ok(m.floating / m.band < 0.02, `floating ${((m.floating / m.band) * 100).toFixed(2)}%`);
  });
}
