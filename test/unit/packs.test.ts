import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_SCHEMA } from '../../src/core/settings';
import { MOLANG, EFFECT_TOP, EFFECT_WALL } from '../../src/core/types';
import { EXPIRE_BLOCKS } from '../../src/core/palette';
import { FOG_DISTANCES } from '../../src/core/fog';
import { MENU_PAGES, PRESET_NAMES } from '../../src/core/ui-model';

const ROOT = join(import.meta.dirname, '..', '..');
const RP = join(ROOT, 'packs', 'resource_pack');
const BP = join(ROOT, 'packs', 'behavior_pack');

function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function lang(path: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('##')) continue;
    const i = line.indexOf('=');
    assert.ok(i > 0, `bad lang line: ${line}`);
    const key = line.slice(0, i);
    assert.ok(!m.has(key), `duplicate lang key ${key}`);
    m.set(key, line.slice(i + 1));
  }
  return m;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('every json file in both packs parses', () => {
  for (const f of [...walk(RP), ...walk(BP)].filter((f) => f.endsWith('.json'))) {
    assert.doesNotThrow(() => json(f), f);
  }
});

test('particles use the script variables and self-cull block list', () => {
  for (const [file, id, facing] of [
    ['lod_top.json', EFFECT_TOP, 'emitter_transform_xz'],
    ['lod_wall.json', EFFECT_WALL, 'lookat_y'],
  ] as const) {
    const p = json(join(RP, 'particles', file));
    assert.equal(p.format_version, '1.10.0');
    assert.equal(p.particle_effect.description.identifier, id);
    const c = p.particle_effect.components;
    assert.equal(c['minecraft:particle_appearance_billboard'].facing_camera_mode, facing);
    assert.deepEqual(c['minecraft:particle_expire_if_in_blocks'], [...EXPIRE_BLOCKS]);
    const text = JSON.stringify(p);
    for (const v of Object.values(MOLANG)) assert.ok(text.includes(v.replace('variable.', 'v.')), `${file} uses ${v}`);
    const tex = p.particle_effect.description.basic_render_parameters.texture;
    assert.ok(existsSync(join(RP, `${tex}.png`)), tex);
  }
  const compat = json(join(RP, 'subpacks', 'compat', 'particles', 'lod_top.json'));
  const bb = compat.particle_effect.components['minecraft:particle_appearance_billboard'];
  assert.equal(bb.facing_camera_mode, 'direction_z');
  assert.equal(bb.direction.mode, 'custom');
});

test('a fog definition exists for every distance step and family', () => {
  const ids = new Set<string>();
  for (const f of readdirSync(join(RP, 'fogs'))) {
    const fog = json(join(RP, 'fogs', f))['minecraft:fog_settings'];
    ids.add(fog.description.identifier);
    const air = fog.distance.air;
    assert.equal(air.render_distance_type, 'fixed');
    assert.ok(air.fog_start < air.fog_end);
    const d = Number(/_(\d+)$/.exec(fog.description.identifier)![1]);
    assert.ok(air.fog_end <= d * 16 - 20, `${fog.description.identifier} ends inside the LOD edge`);
    assert.ok(!('water' in fog.distance), 'water fog stays vanilla');
  }
  for (const d of FOG_DISTANCES) for (const fam of ['horizon', 'haze', 'end']) assert.ok(ids.has(`dl:${fam}_${d}`), `dl:${fam}_${d}`);
});

test('manifests declare subpacks, dependencies and versions', () => {
  const rp = json(join(RP, 'manifest.json'));
  const bp = json(join(BP, 'manifest.json'));
  const folders = rp.subpacks.map((s: any) => s.folder_name);
  assert.deepEqual(folders, ['standard', 'smooth', 'compat']);
  for (const f of folders) assert.ok(existsSync(join(RP, 'subpacks', f)), f);
  const uuids = [rp.header.uuid, ...rp.modules.map((m: any) => m.uuid), bp.header.uuid, ...bp.modules.map((m: any) => m.uuid)];
  assert.equal(new Set(uuids).size, uuids.length, 'unique uuids');
  for (const u of uuids) assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(existsSync(join(RP, 'pack_icon.png')) && existsSync(join(BP, 'pack_icon.png')));
});

test('item, recipe and item texture are consistent', () => {
  const item = json(join(BP, 'items', 'horizon_lens.json'))['minecraft:item'];
  assert.equal(item.description.identifier, 'dl:horizon_lens');
  const icon = item.components['minecraft:icon'].textures.default;
  const atlas = json(join(RP, 'textures', 'item_texture.json'));
  const path = atlas.texture_data[icon].textures;
  assert.ok(existsSync(join(RP, `${path}.png`)), path);
  const recipe = json(join(BP, 'recipes', 'horizon_lens.json'))['minecraft:recipe_shapeless'];
  assert.equal(recipe.result.item, 'dl:horizon_lens');
  assert.ok(recipe.unlock.length > 0);
});

test('every translation key used by the add-on exists', () => {
  const rp = lang(join(RP, 'texts', 'en_US.lang'));
  const bp = lang(join(BP, 'texts', 'en_US.lang'));
  for (const k of ['pack.name', 'pack.description']) assert.ok(rp.has(k) && bp.has(k), k);
  const needed = new Set<string>(['item.dl:horizon_lens.name']);
  for (const d of SETTINGS_SCHEMA) {
    needed.add(`dl.setting.${d.key}`);
    needed.add(`dl.tip.${d.key}`);
    needed.add(`dl.group.${d.group}`);
    for (const o of d.options ?? []) needed.add(`dl.opt.${d.key}.${o}`);
  }
  for (const p of MENU_PAGES) needed.add(p.label);
  for (const n of PRESET_NAMES) needed.add(`dl.preset.${n}`);
  for (const f of walk(join(ROOT, 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/'(dl\.(?:ui|msg|page|preset)\.[a-z0-9_]+)'/g)) needed.add(m[1]);
  }
  const missing = [...needed].filter((k) => !rp.has(k));
  assert.deepEqual(missing, []);
  for (const [k, v] of rp) assert.ok(v.trim().length > 0, `empty ${k}`);
});
