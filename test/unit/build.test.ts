import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
// @ts-ignore - plain ESM build script
import { build, pack } from '../../scripts/build.mjs';

/** A temporary folder removed when the test ends. */
function scratch(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('build bundles the behavior pack script with external minecraft modules', async (t) => {
  const out = scratch(t, 'dl-build-');
  const result = await build({ outDir: out });
  const main = join(result.bpDir, 'scripts', 'main.js');
  assert.ok(existsSync(main), 'main.js should exist');
  const src = readFileSync(main, 'utf8');
  assert.match(src, /from\s*["']@minecraft\/server["']/);
  assert.ok(existsSync(join(result.bpDir, 'manifest.json')));
  assert.ok(existsSync(join(result.rpDir, 'manifest.json')));
});

test('pack produces an mcaddon containing both packs', async (t) => {
  const out = scratch(t, 'dl-pack-');
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

test('the packed mcaddon passes the release validator, which catches broken archives', async (t) => {
  // @ts-ignore - plain ESM validation script
  const { validateAddon } = await import('../../scripts/validate-packs.mjs');
  const out = scratch(t, 'dl-validate-');
  const file = await pack(await build({ outDir: out }), join(out, 'dist'));
  const bytes = readFileSync(file);
  assert.deepEqual(validateAddon(bytes).problems, []);
  assert.equal(readFileSync(await pack(await build({ outDir: join(out, 'again') }), join(out, 'dist2'))).equals(bytes), true, 'packing is deterministic');

  const files = unzipSync(bytes);
  const broken = (edit: (f: Record<string, Uint8Array>) => void) => {
    const copy = { ...files };
    edit(copy);
    return validateAddon(zipSync(copy)).problems.join('\n');
  };
  const editJson = (f: Record<string, Uint8Array>, name: string, change: (j: any) => void) => {
    const j = JSON.parse(strFromU8(f[name]));
    change(j);
    f[name] = strToU8(JSON.stringify(j));
  };
  assert.match(broken((f) => delete f['DistantLands_RP/textures/particle/dl_lod.png']), /texture .* missing/);
  assert.match(broken((f) => editJson(f, 'DistantLands_BP/manifest.json', (m) => (m.header.version = [9, 9, 9]))), /header\.version/);
  assert.match(broken((f) => editJson(f, 'DistantLands_RP/manifest.json', (m) => (m.header.uuid = m.modules[0].uuid))), /not unique|depend/);
  assert.match(
    broken((f) => (f['DistantLands_BP/scripts/main.js'] = strToU8(`import "@minecraft/server-net";\n${strFromU8(f['DistantLands_BP/scripts/main.js'])}`))),
    /server-net/,
  );
  assert.match(broken((f) => (f['DistantLands_BP/notes.md'] = strToU8('#'))), /development file/);
  assert.match(broken((f) => (f['DistantLands_RP/fogs/broken.json'] = strToU8('{'))), /invalid JSON/);
});
