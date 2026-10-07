import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
// @ts-ignore - plain ESM build script
import { build, pack } from '../../scripts/build.mjs';

test('build bundles the behavior pack script with external minecraft modules', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dl-build-'));
  const result = await build({ outDir: out });
  const main = join(result.bpDir, 'scripts', 'main.js');
  assert.ok(existsSync(main), 'main.js should exist');
  const src = readFileSync(main, 'utf8');
  assert.match(src, /from\s*["']@minecraft\/server["']/);
  assert.ok(existsSync(join(result.bpDir, 'manifest.json')));
  assert.ok(existsSync(join(result.rpDir, 'manifest.json')));
});

test('pack produces an mcaddon containing both packs', async () => {
  const out = mkdtempSync(join(tmpdir(), 'dl-pack-'));
  const result = await build({ outDir: out });
  const file = await pack(result, join(out, 'dist'));
  const entries = unzipSync(readFileSync(file));
  const names = Object.keys(entries);
  assert.ok(names.includes('DistantLands_BP/manifest.json'), names.join(','));
  assert.ok(names.includes('DistantLands_RP/manifest.json'), names.join(','));
  assert.ok(names.includes('DistantLands_BP/scripts/main.js'));
  const bp = JSON.parse(strFromU8(entries['DistantLands_BP/manifest.json']));
  const rp = JSON.parse(strFromU8(entries['DistantLands_RP/manifest.json']));
  assert.equal(bp.format_version, 2);
  assert.deepEqual(bp.header.min_engine_version, [1, 26, 0]);
  const deps = Object.fromEntries(bp.dependencies.filter((d: any) => d.module_name).map((d: any) => [d.module_name, d.version]));
  assert.equal(deps['@minecraft/server'], '2.5.0');
  assert.equal(deps['@minecraft/server-ui'], '2.0.0');
  assert.ok(bp.dependencies.some((d: any) => d.uuid === rp.header.uuid), 'BP depends on RP');
  assert.ok(rp.dependencies.some((d: any) => d.uuid === bp.header.uuid), 'RP depends on BP');
});
