/**
 * Generates the data-driven pack files from the same constants the script uses:
 * particles (Molang variable names, self-cull block list), fogs (distance steps), lang files, item and recipe.
 * Run: npm run assets   (images are produced by scripts/gen-images.py)
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXPIRE_BLOCKS } from '../src/core/palette';
import { FOG_DISTANCES, fogEnd } from '../src/core/fog';
import { MOLANG, EFFECT_TOP, EFFECT_WALL } from '../src/core/types';
import { SETTINGS_SCHEMA } from '../src/core/settings';
import { PACK, SETTINGS, GROUPS, PAGES, PRESETS, UI, ITEMS } from './lang-en';

const ROOT = join(import.meta.dirname, '..');
const RP = join(ROOT, 'packs', 'resource_pack');
const BP = join(ROOT, 'packs', 'behavior_pack');

function write(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
}

const v = (name: string) => name.replace('variable.', 'v.');
const V = Object.fromEntries(Object.entries(MOLANG).map(([k, n]) => [k, v(n)])) as Record<keyof typeof MOLANG, string>;

/** Shared particle components. `billboard` holds facing mode and direction. */
function particle(id: string, billboard: Record<string, unknown>, material = 'particles_alpha') {
  return {
    format_version: '1.10.0',
    particle_effect: {
      description: {
        identifier: id,
        basic_render_parameters: { material, texture: 'textures/particle/dl_lod' },
      },
      components: {
        'minecraft:emitter_rate_instant': { num_particles: 1 },
        'minecraft:emitter_lifetime_once': { active_time: 0.05 },
        'minecraft:emitter_shape_point': { offset: [V.ox, V.oy, V.oz] },
        'minecraft:particle_lifetime_expression': { max_lifetime: V.life },
        'minecraft:particle_initial_speed': 0,
        'minecraft:particle_initialization': {
          // v.k: grow-in factor (smoothstep), v.lit: day/night brightness extrapolated over the particle's life.
          per_render_expression:
            `v.k = ${V.grow} > 0 ? math.clamp(v.particle_age / ${V.grow}, 0, 1) : 1;` +
            ` v.k = v.k * v.k * (3 - 2 * v.k);` +
            ` v.lit = math.clamp(${V.l0} + ${V.dl} * v.particle_age, 0.05, 1);`,
        },
        'minecraft:particle_appearance_billboard': {
          size: [`${V.a} * v.k`, `${V.b} * v.k`],
          ...billboard,
          uv: { texture_width: 16, texture_height: 16, uv: [0, 0], uv_size: [16, 16] },
        },
        'minecraft:particle_appearance_tinting': {
          color: [`${V.r} * v.lit`, `${V.g} * v.lit`, `${V.bl} * v.lit`, 1.0],
        },
        // The quad disappears as soon as the client has the real block at its position.
        'minecraft:particle_expire_if_in_blocks': [...EXPIRE_BLOCKS],
      },
    },
  };
}

function particles(): void {
  write(join(RP, 'particles', 'lod_top.json'), particle(EFFECT_TOP, { facing_camera_mode: 'emitter_transform_xz' }));
  write(join(RP, 'particles', 'lod_wall.json'), particle(EFFECT_WALL, { facing_camera_mode: 'lookat_y' }));
  // Compatibility subpack: horizontal faces from a custom direction instead of the emitter transform.
  write(
    join(RP, 'subpacks', 'compat', 'particles', 'lod_top.json'),
    particle(EFFECT_TOP, {
      facing_camera_mode: 'direction_z',
      direction: { mode: 'custom', custom_direction: [0, 1, 0.001] },
    }),
  );
}

function fog(id: string, airStart: number, airEnd: number, airColor: string, weatherColor: string) {
  return {
    format_version: '1.16.100',
    'minecraft:fog_settings': {
      description: { identifier: id },
      distance: {
        air: { fog_start: airStart, fog_end: airEnd, fog_color: airColor, render_distance_type: 'fixed' },
        weather: {
          fog_start: Math.round(airEnd * 0.25),
          fog_end: Math.round(airEnd * 0.7),
          fog_color: weatherColor,
          render_distance_type: 'fixed',
        },
      },
    },
  };
}

function fogs(): void {
  for (const d of FOG_DISTANCES) {
    const end = fogEnd(d);
    write(join(RP, 'fogs', `dl_horizon_${d}.json`), fog(`dl:horizon_${d}`, Math.round(end * 0.62), end, '#ABD2FF', '#666666'));
    write(join(RP, 'fogs', `dl_haze_${d}.json`), fog(`dl:haze_${d}`, Math.round(end * 0.3), end, '#B4CBE8', '#6A6A6A'));
    write(join(RP, 'fogs', `dl_end_${d}.json`), fog(`dl:end_${d}`, Math.round(end * 0.55), end, '#0B080C', '#0B080C'));
  }
}

function langLines(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([k, t]) => `${k}=${t.replace(/\n/g, '\\n')}`)
    .join('\n');
}

function lang(): void {
  const settings: Record<string, string> = {};
  for (const def of SETTINGS_SCHEMA) {
    const s = SETTINGS[def.key];
    if (!s) throw new Error(`missing English text for setting ${def.key}`);
    settings[`dl.setting.${def.key}`] = s[0];
    settings[`dl.tip.${def.key}`] = s[1];
    for (const o of def.options ?? []) {
      const label = s[2]?.[o];
      if (!label) throw new Error(`missing English text for ${def.key}.${o}`);
      settings[`dl.opt.${def.key}.${o}`] = label;
    }
  }
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([k, t]) => [`dl.group.${k}`, t]));
  const pages = Object.fromEntries(Object.entries(PAGES).map(([k, t]) => [`dl.page.${k}`, t]));
  const presets = Object.fromEntries(Object.entries(PRESETS).map(([k, t]) => [`dl.preset.${k}`, t]));
  const header = '## Generated by scripts/gen-assets.ts from scripts/lang-en.ts';
  write(
    join(RP, 'texts', 'en_US.lang'),
    [header, langLines(PACK), langLines(ITEMS), langLines(UI), langLines(pages), langLines(groups), langLines(presets), langLines(settings)].join('\n') + '\n',
  );
  write(join(BP, 'texts', 'en_US.lang'), [header, langLines(PACK)].join('\n') + '\n');
  write(join(RP, 'texts', 'languages.json'), ['en_US']);
  write(join(BP, 'texts', 'languages.json'), ['en_US']);
}

function items(): void {
  write(join(BP, 'items', 'horizon_lens.json'), {
    format_version: '1.21.60',
    'minecraft:item': {
      description: { identifier: 'dl:horizon_lens', menu_category: { category: 'equipment' } },
      components: {
        'minecraft:icon': { textures: { default: 'dl_horizon_lens' } },
        'minecraft:display_name': { value: 'item.dl:horizon_lens.name' },
        'minecraft:max_stack_size': 1,
      },
    },
  });
  write(join(BP, 'recipes', 'horizon_lens.json'), {
    format_version: '1.21.60',
    'minecraft:recipe_shapeless': {
      description: { identifier: 'dl:horizon_lens' },
      tags: ['crafting_table'],
      ingredients: [{ item: 'minecraft:compass' }, { item: 'minecraft:glass_pane' }],
      unlock: [{ item: 'minecraft:compass' }],
      result: { item: 'dl:horizon_lens' },
    },
  });
  write(join(RP, 'textures', 'item_texture.json'), {
    resource_pack_name: 'distant_lands',
    texture_name: 'atlas.items',
    texture_data: { dl_horizon_lens: { textures: 'textures/items/dl_horizon_lens' } },
  });
}

function manifest(): void {
  const path = join(RP, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.subpacks = [
    { folder_name: 'standard', name: 'Standard (textured, emitter-aligned faces)' },
    { folder_name: 'smooth', name: 'Smooth (flat colours)' },
    { folder_name: 'compat', name: 'Compatibility (direction-aligned faces)' },
  ];
  write(path, m);
}

particles();
fogs();
lang();
items();
manifest();
console.log('assets generated');
