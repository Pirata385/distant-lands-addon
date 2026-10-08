// Validates the add-on exactly as it ships: builds and packs a fresh .mcaddon, then checks the archive itself
// (layout, manifests, versions, script imports, JSON, texture and language references).
// When dist/ holds a committed .mcaddon it must be byte-identical to the fresh build (packing is deterministic).
// Usage: node scripts/validate-packs.mjs [file.mcaddon]
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, pack, BP_NAME, RP_NAME } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const MIN_ENGINE = [1, 26, 0];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/** Returns a list of problems found in the .mcaddon bytes (empty when valid). */
export function validateAddon(bytes) {
  const problems = [];
  const check = (ok, msg) => {
    if (!ok) problems.push(msg);
  };
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const text = (name) => strFromU8(files[name]);
  const json = (name) => {
    try {
      return JSON.parse(text(name));
    } catch (e) {
      problems.push(`${name}: invalid JSON (${e.message})`);
      return undefined;
    }
  };
  const has = (name) => name in files;
  const hasDir = (prefix) => names.some((n) => n.startsWith(prefix));

  for (const n of names) {
    check(n.startsWith(`${BP_NAME}/`) || n.startsWith(`${RP_NAME}/`), `${n}: outside the two pack folders`);
    check(!/\.(ts|mts|md|map|py|mjs)$/i.test(n), `${n}: development file shipped`);
    check(!n.split('/').some((part) => part.startsWith('.')), `${n}: hidden file shipped`);
    if (n.endsWith('.json')) json(n);
    if (n.endsWith('.png')) check(PNG_SIGNATURE.every((b, i) => files[n][i] === b), `${n}: not a PNG`);
  }

  const version = pkg.version.split('.').map(Number);
  const manifests = {};
  for (const packName of [BP_NAME, RP_NAME]) {
    const path = `${packName}/manifest.json`;
    check(has(path), `${path}: missing`);
    check(has(`${packName}/pack_icon.png`), `${packName}/pack_icon.png: missing`);
    const m = has(path) ? json(path) : undefined;
    if (!m) continue;
    manifests[packName] = m;
    check(m.format_version === 2, `${path}: format_version must be 2`);
    check(JSON.stringify(m.header?.version) === JSON.stringify(version), `${path}: header.version must be ${pkg.version}`);
    const engine = m.header?.min_engine_version ?? [];
    const cmp = engine.reduce((c, v, i) => c || Math.sign(v - MIN_ENGINE[i]), 0);
    check(cmp >= 0, `${path}: min_engine_version below ${MIN_ENGINE.join('.')}`);
    for (const u of [m.header?.uuid, ...(m.modules ?? []).map((x) => x.uuid)]) check(UUID_V4.test(u ?? ''), `${path}: bad uuid ${u}`);
    for (const key of ['name', 'description']) check(m.header?.[key] === `pack.${key}`, `${path}: header.${key} should use pack.${key}`);
    check(has(`${packName}/texts/en_US.lang`), `${packName}/texts/en_US.lang: missing`);
    if (has(`${packName}/texts/en_US.lang`)) {
      const lang = text(`${packName}/texts/en_US.lang`);
      for (const key of ['pack.name', 'pack.description']) check(new RegExp(`^${key}=.+`, 'm').test(lang), `${packName}: lang key ${key} missing`);
    }
    if (has(`${packName}/texts/languages.json`)) {
      const langs = json(`${packName}/texts/languages.json`) ?? [];
      for (const l of langs) check(has(`${packName}/texts/${l}.lang`), `${packName}/texts/${l}.lang: listed but missing`);
    }
  }
  const bp = manifests[BP_NAME];
  const rp = manifests[RP_NAME];
  if (bp && rp) {
    const uuids = [bp, rp].flatMap((m) => [m.header.uuid, ...m.modules.map((x) => x.uuid)]);
    check(new Set(uuids).size === uuids.length, 'manifests: uuids are not unique');
    const dep = (m, uuid) => (m.dependencies ?? []).find((d) => d.uuid === uuid);
    check(JSON.stringify(dep(bp, rp.header.uuid)?.version) === JSON.stringify(rp.header.version), 'behavior pack must depend on this resource pack version');
    check(JSON.stringify(dep(rp, bp.header.uuid)?.version) === JSON.stringify(bp.header.version), 'resource pack must depend on this behavior pack version');

    const script = bp.modules.find((x) => x.type === 'script');
    check(script?.language === 'javascript', 'behavior pack: javascript script module missing');
    const entry = script ? `${BP_NAME}/${script.entry}` : '';
    check(has(entry), `${entry || 'script entry'}: missing`);
    const modules = new Map((bp.dependencies ?? []).filter((d) => d.module_name).map((d) => [d.module_name, d.version]));
    for (const [name, v] of modules) check(pkg.devDependencies[name] === v, `${name}: manifest ${v} but typings ${pkg.devDependencies[name]}`);
    if (has(entry)) {
      const src = text(entry);
      const specifiers = [...src.matchAll(/\bimport\s*(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g)].map((x) => x[1] ?? x[2]);
      check(specifiers.length > 0, `${entry}: no imports found (expected @minecraft modules)`);
      for (const s of specifiers) check(modules.has(s), `${entry}: imports ${s} which the manifest does not declare`);
    }

    for (const s of rp.subpacks ?? []) check(hasDir(`${RP_NAME}/subpacks/${s.folder_name}/`), `subpack ${s.folder_name}: folder missing`);

    const texture = (path) => has(`${RP_NAME}/${path}.png`) || has(`${RP_NAME}/${path}.tga`);
    for (const n of names.filter((x) => x.startsWith(`${RP_NAME}/`) && x.includes('/particles/') && x.endsWith('.json'))) {
      const tex = json(n)?.particle_effect?.description?.basic_render_parameters?.texture;
      check(tex && texture(tex), `${n}: texture ${tex} missing`);
    }
    const atlasPath = `${RP_NAME}/textures/item_texture.json`;
    const atlas = has(atlasPath) ? (json(atlasPath)?.texture_data ?? {}) : {};
    for (const [key, t] of Object.entries(atlas)) {
      for (const p of [t.textures].flat()) check(texture(p), `${atlasPath}: ${key} -> ${p} missing`);
    }
    for (const n of names.filter((x) => x.startsWith(`${BP_NAME}/items/`) && x.endsWith('.json'))) {
      const icon = json(n)?.['minecraft:item']?.components?.['minecraft:icon']?.textures?.default;
      check(icon && icon in atlas, `${n}: icon ${icon} not in item_texture.json`);
    }
    const fogIds = names
      .filter((x) => x.startsWith(`${RP_NAME}/fogs/`) && x.endsWith('.json'))
      .map((x) => json(x)?.['minecraft:fog_settings']?.description?.identifier);
    check(fogIds.length > 0 && new Set(fogIds).size === fogIds.length, 'fogs: missing or duplicate identifiers');
  }
  return { problems, files: names.length };
}

async function main() {
  const arg = process.argv[2];
  let file;
  let tmp;
  if (arg) {
    file = resolve(arg);
  } else {
    const base = join(root, 'test-output');
    mkdirSync(base, { recursive: true });
    tmp = mkdtempSync(join(base, 'validate-'));
    file = await pack(await build({ outDir: join(tmp, 'build') }), join(tmp, 'dist'));
  }
  const bytes = readFileSync(file);
  const { problems, files } = validateAddon(bytes);
  if (!arg) {
    const committed = join(root, 'dist', `DistantLands-v${pkg.version}.mcaddon`);
    if (existsSync(committed) && !readFileSync(committed).equals(bytes)) {
      problems.push(`${relative(root, committed)} is out of date: run "npm run pack" and commit it`);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${arg ? relative(root, file) : 'fresh build'}: ${files} files, ${(bytes.length / 1024).toFixed(1)} KB, no problems`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
