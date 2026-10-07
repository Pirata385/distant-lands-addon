import { PALETTE_DATA } from './palette-data';
import { F_WATER } from './flags';

/** Script API colour (channels 0..1). */
export interface RGB {
  red: number;
  green: number;
  blue: number;
}

/** Colours are packed as 0xRRGGBB integers everywhere in the LOD pipeline. */
export function rgb(r: number, g: number, b: number): number {
  const cr = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
  const cg = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
  const cb = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  return (cr << 16) | (cg << 8) | cb;
}

export function unpack(c: number): { r: number; g: number; b: number } {
  return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
}

export function scale(c: number, f: number): number {
  return rgb(((c >> 16) & 255) * f, ((c >> 8) & 255) * f, (c & 255) * f);
}

export function mix(a: number, b: number, t: number): number {
  const u = 1 - t;
  return rgb(
    ((a >> 16) & 255) * u + ((b >> 16) & 255) * t,
    ((a >> 8) & 255) * u + ((b >> 8) & 255) * t,
    (a & 255) * u + (b & 255) * t,
  );
}

export function luma(c: number): number {
  return 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
}

export function saturate(c: number, f: number): number {
  const l = luma(c);
  return rgb(
    l + (((c >> 16) & 255) - l) * f,
    l + (((c >> 8) & 255) - l) * f,
    l + ((c & 255) - l) * f,
  );
}

let table: Map<string, number> | undefined;

function getTable(): Map<string, number> {
  if (!table) {
    table = new Map();
    for (const entry of PALETTE_DATA.split(',')) {
      const i = entry.indexOf(':');
      table.set(entry.slice(0, i), parseInt(entry.slice(i + 1), 16));
    }
  }
  return table;
}

/** Ids renamed between game versions: newer name -> name present in the generated table, and vice versa. */
const RUNTIME_ALIASES: Record<string, string> = {
  sugar_cane: 'reeds',
  reeds: 'sugar_cane',
  lily_pad: 'waterlily',
  waterlily: 'lily_pad',
  terracotta: 'hardened_clay',
  hardened_clay: 'terracotta',
  grass: 'grass_block',
};

/** Average top-face colour of a vanilla block (biome-tinted blocks are grey here). */
export function baseColor(typeId: string): number | undefined {
  if (!typeId.startsWith('minecraft:')) return undefined;
  const name = typeId.slice(10);
  const t = getTable();
  const direct = t.get(name);
  if (direct !== undefined) return direct;
  const alias = RUNTIME_ALIASES[name];
  return alias === undefined ? undefined : t.get(alias);
}

/**
 * Multiplies a texture colour by the biome tint the engine applied to the block's map colour
 * (tint = tintedColor / color, per channel). Channels whose base is ~0 carry no tint information.
 */
export function applyTint(base: number, tinted: RGB, mapBase: RGB): number {
  const fr = mapBase.red > 0.004 ? tinted.red / mapBase.red : 1;
  const fg = mapBase.green > 0.004 ? tinted.green / mapBase.green : 1;
  const fb = mapBase.blue > 0.004 ? tinted.blue / mapBase.blue : 1;
  return rgb(((base >> 16) & 255) * fr, ((base >> 8) & 255) * fg, (base & 255) * fb);
}

/** Converts a Script API colour (0..1 channels) to a packed colour. */
export function fromRGB(c: RGB): number {
  return rgb(c.red * 255, c.green * 255, c.blue * 255);
}

// ---------------------------------------------------------------------------------------------
// Block classes used by the sampler.

const DECORATION_IDS = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'seagrass', 'tall_seagrass', 'nether_sprouts',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'peony', 'torchflower', 'pitcher_plant',
  'wildflowers', 'cactus_flower', 'open_eyeblossom', 'closed_eyeblossom', 'leaf_litter',
  'short_dry_grass', 'tall_dry_grass', 'torchflower_crop', 'pitcher_crop', 'red_flower', 'yellow_flower',
  'wheat', 'carrots', 'potatoes', 'beetroot', 'melon_stem', 'pumpkin_stem', 'sweet_berry_bush',
  'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'crimson_roots', 'warped_roots',
  'hanging_roots', 'pale_hanging_moss', 'spore_blossom', 'glow_lichen', 'sculk_vein', 'vine',
  'cobweb', 'web', 'ladder', 'lever', 'tripwire_hook', 'trip_wire', 'redstone_wire',
  'unpowered_repeater', 'powered_repeater', 'unpowered_comparator', 'powered_comparator',
  'torch', 'rail', 'lantern', 'soul_lantern', 'fire', 'soul_fire', 'end_rod', 'lightning_rod', 'chain',
  'iron_chain', 'structure_void', 'barrier', 'light_block', 'waterlily', 'lily_pad', 'reeds', 'sugar_cane',
  'bamboo_sapling', 'mangrove_propagule', 'snow_golem', 'frame', 'glow_frame', 'string', 'scaffolding',
  'kelp', 'kelp_plant', 'small_dripleaf_block', 'big_dripleaf', 'cave_vines', 'cave_vines_body_with_berries',
  'cave_vines_head_with_berries', 'weeping_vines', 'twisting_vines', 'deadbush', 'bush', 'firefly_bush',
]);

const DECORATION_SUFFIX =
  /(_sapling|_carpet|_button|_pressure_plate|_sign|_hanging_sign|_banner|_torch|_rail|_tulip|_petals|_coral_fan|_coral_wall_fan|_candle|_bush|_head|_skull|_pot)$/;
const DECORATION_PREFIX = /^(light_block_|candle)/;

/** Small or non-occluding blocks the sampler looks through to find the ground. */
export function isDecoration(typeId: string): boolean {
  const name = typeId.startsWith('minecraft:') ? typeId.slice(10) : typeId;
  if (DECORATION_IDS.has(name)) return true;
  if (name.endsWith('_mushroom_block') || name === 'sea_lantern') return false;
  return DECORATION_SUFFIX.test(name) || DECORATION_PREFIX.test(name);
}

export function isFoliage(typeId: string): boolean {
  const name = typeId.startsWith('minecraft:') ? typeId.slice(10) : typeId;
  return name.endsWith('_leaves') || name.startsWith('azalea_leaves') || name === 'leaves' || name === 'leaves2';
}

const GROUND_COVER_IDS = new Set([
  'mangrove_roots', 'bamboo', 'vine', 'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem',
  'bee_nest', 'cocoa', 'azalea', 'flowering_azalea', 'cactus', 'pale_moss_carpet',
]);

/** Blocks skipped in "Ground" vegetation mode (trees and other tall vegetation). */
export function isGroundCover(typeId: string): boolean {
  const name = typeId.startsWith('minecraft:') ? typeId.slice(10) : typeId;
  if (isFoliage(typeId) || GROUND_COVER_IDS.has(name)) return true;
  return /_(log|wood)$/.test(name) && !name.startsWith('stripped_');
}

export function isSnow(typeId: string): boolean {
  return typeId === 'minecraft:snow_layer' || typeId === 'minecraft:snow' || typeId === 'minecraft:powder_snow';
}

export function isWater(typeId: string): boolean {
  return typeId === 'minecraft:water' || typeId === 'minecraft:flowing_water';
}

export function isLava(typeId: string): boolean {
  return typeId === 'minecraft:lava' || typeId === 'minecraft:flowing_lava';
}

// ---------------------------------------------------------------------------------------------
// Blocks that make a LOD particle expire when the client has the real block at its position.

const EXPIRE_NATURAL = [
  'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'dirt_with_roots', 'mud', 'muddy_mangrove_roots',
  'mangrove_roots', 'moss_block', 'pale_moss_block', 'farmland', 'grass_path', 'dirt_path', 'clay', 'gravel', 'sand',
  'red_sand', 'sandstone', 'red_sandstone', 'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite',
  'dripstone_block', 'cobblestone', 'mossy_cobblestone', 'hardened_clay', 'terracotta', 'snow', 'snow_layer',
  'powder_snow', 'ice', 'packed_ice', 'blue_ice', 'water', 'flowing_water', 'lava', 'flowing_lava', 'magma',
  'obsidian', 'bedrock', 'netherrack', 'end_stone', 'cactus', 'pumpkin', 'melon_block', 'bamboo',
  'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem', 'azalea', 'flowering_azalea', 'moss_carpet',
  'pale_moss_carpet', 'packed_mud', 'tube_coral_block', 'brain_coral_block', 'bubble_coral_block',
  'fire_coral_block', 'horn_coral_block', 'pointed_dripstone', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem',
];

/** Natural surface blocks only: the client checks this list for every LOD particle, so it must stay short. */
const EXPIRE_PATTERN = /_(leaves|terracotta)$|^azalea_leaves/;

function buildExpireList(): string[] {
  const known = getTable();
  const out = new Set<string>();
  for (const name of EXPIRE_NATURAL) if (known.has(name)) out.add(`minecraft:${name}`);
  for (const name of known.keys()) {
    if (EXPIRE_PATTERN.test(name) && !name.startsWith('glazed') && !name.endsWith('glazed_terracotta')) {
      out.add(`minecraft:${name}`);
    }
  }
  // Snow layers and liquids are real terrain even where the palette has no texture for them.
  for (const name of ['snow_layer', 'flowing_water', 'flowing_lava', 'water', 'lava']) out.add(`minecraft:${name}`);
  return [...out].sort();
}

/** Used to generate `particle_expire_if_in_blocks` in the LOD particle definitions. */
export const EXPIRE_BLOCKS: readonly string[] = buildExpireList();

// ---------------------------------------------------------------------------------------------
// Display styles.

export const STYLE_NATURAL = 0;
export const STYLE_VIVID = 1;
export const STYLE_CARTO = 2;
export const STYLE_ELEVATION = 3;
export const STYLE_DEBUG = 4;

const SEA_LEVEL = 62;
const ELEVATION_STOPS: ReadonlyArray<readonly [number, number]> = [
  [SEA_LEVEL, 0x4f8a3a],
  [90, 0x7da34a],
  [120, 0xa08a5a],
  [160, 0x8a7f73],
  [200, 0xb0b0b0],
  [240, 0xf4f8ff],
];
const DEBUG_LEVELS = [0x43a047, 0x1e88e5, 0xfb8c00, 0xd81b60, 0x8e24aa, 0x00acc1, 0xfdd835];

function elevationColor(height: number): number {
  if (height <= ELEVATION_STOPS[0][0]) return ELEVATION_STOPS[0][1];
  for (let i = 1; i < ELEVATION_STOPS.length; i++) {
    const [h1, c1] = ELEVATION_STOPS[i];
    if (height <= h1) {
      const [h0, c0] = ELEVATION_STOPS[i - 1];
      return mix(c0, c1, (height - h0) / (h1 - h0));
    }
  }
  return ELEVATION_STOPS[ELEVATION_STOPS.length - 1][1];
}

/**
 * Applies a display style to a LOD cell colour.
 * @param level LOD level (0 = finest cell size), only used by the debug style.
 */
export function styleColor(style: number, color: number, height: number, flags: number, level: number): number {
  switch (style) {
    case STYLE_VIVID: {
      const s = saturate(color, 1.4);
      return mix(s, scale(s, 1.08), 0.5);
    }
    case STYLE_CARTO: {
      const s = saturate(color, 1.15);
      const q = (v: number) => Math.min(255, Math.round(v / 24) * 24 + 8);
      const u = unpack(s);
      return rgb(q(u.r), q(u.g), q(u.b));
    }
    case STYLE_ELEVATION:
      if (flags & F_WATER) return mix(0x2f5fb3, 0x6fa8e8, Math.max(0, Math.min(1, (height - 40) / 30)));
      return elevationColor(height);
    case STYLE_DEBUG: {
      const tint = DEBUG_LEVELS[Math.min(level, DEBUG_LEVELS.length - 1)];
      return mix(tint, rgb(luma(color), luma(color), luma(color)), 0.3);
    }
    default:
      return color;
  }
}
