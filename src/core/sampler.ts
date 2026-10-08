import { ChunkLod } from './lod/chunk-lod';
import { F_FOLIAGE, F_SNOW, F_VOID, F_WATER, NO_DATA } from './flags';
import { applyTint, baseColor, fromRGB, isDecoration, isFoliage, isGroundCover, isSnow, isWater, rgb } from './palette';
import type { HostBlock, HostDimension } from './types';

export const VEG_CANOPY = 0;
export const VEG_GROUND = 1;

export interface SamplerOptions {
  /** Measure water depth with a downward ray (one extra call per water sample). */
  waterDepth: boolean;
  /** VEG_CANOPY keeps trees as part of the silhouette, VEG_GROUND looks through them. */
  vegetation: number;
}

/** Underwater plants that can be the topmost block of a water column. */
const WATER_PLANTS = new Set(['minecraft:kelp', 'minecraft:seagrass', 'minecraft:sea_pickle', 'minecraft:bubble_column']);
const WATER_PLANT_TYPES = [...WATER_PLANTS];

const GROUND_SKIP_TYPES = [
  'minecraft:oak_leaves', 'minecraft:spruce_leaves', 'minecraft:birch_leaves', 'minecraft:jungle_leaves',
  'minecraft:acacia_leaves', 'minecraft:dark_oak_leaves', 'minecraft:mangrove_leaves', 'minecraft:cherry_leaves',
  'minecraft:pale_oak_leaves', 'minecraft:azalea_leaves', 'minecraft:azalea_leaves_flowered', 'minecraft:oak_log',
  'minecraft:spruce_log', 'minecraft:birch_log', 'minecraft:jungle_log', 'minecraft:acacia_log',
  'minecraft:dark_oak_log', 'minecraft:mangrove_log', 'minecraft:cherry_log', 'minecraft:pale_oak_log',
  'minecraft:mangrove_roots', 'minecraft:vine', 'minecraft:bamboo', 'minecraft:brown_mushroom_block',
  'minecraft:red_mushroom_block', 'minecraft:mushroom_stem', 'minecraft:bee_nest', 'minecraft:cocoa',
];

const WATER_FALLBACK = rgb(63, 118, 228);
const SNOW_COLOR = baseColor('minecraft:snow') ?? rgb(249, 254, 254);
const GREY = rgb(128, 128, 128);
const MAX_DEPTH_RAY = 48;
/** Samples processed between yields. */
const SAMPLES_PER_SLICE = 8;

interface Sample {
  h: number;
  c: number;
  f: number;
  d: number;
}

function blockColor(b: HostBlock): number {
  const base = baseColor(b.typeId);
  const mc = b.mapColor();
  if (base !== undefined) return mc ? applyTint(base, mc.tinted, mc.base) : base;
  return mc ? fromRGB(mc.tinted) : GREY;
}

function sampleColumn(dim: HostDimension, x: number, z: number, opts: SamplerOptions, out: Sample): void {
  let b = dim.topmost(x, z);
  if (!b) {
    out.h = NO_DATA;
    out.f = F_VOID;
    out.c = 0;
    out.d = 0;
    return;
  }
  // Water plants reaching the surface are waterlogged: the column is water (they are decorations otherwise).
  for (let steps = 0; steps < 4 && b && !WATER_PLANTS.has(b.typeId) && isDecoration(b.typeId); steps++) b = b.below();
  if (!b) {
    out.h = NO_DATA;
    out.f = F_VOID;
    out.c = 0;
    out.d = 0;
    return;
  }
  out.d = 0;
  if (b.typeId === 'minecraft:snow_layer') {
    // A snow layer is a thin sheet on the block below: keep the ground surface height.
    out.h = b.y;
    out.c = SNOW_COLOR;
    out.f = F_SNOW;
    return;
  }
  if (opts.vegetation === VEG_GROUND && isGroundCover(b.typeId)) {
    const ground = dim.rayDown(x + 0.5, b.y, z + 0.5, b.y - dim.minY, { liquids: true, skipTypes: GROUND_SKIP_TYPES });
    if (ground) b = ground;
  }
  if (isWater(b.typeId) || WATER_PLANTS.has(b.typeId)) {
    out.h = b.y + 1;
    out.f = F_WATER;
    out.c = isWater(b.typeId) ? blockColor(b) : WATER_FALLBACK;
    if (opts.waterDepth) {
      const floor = dim.rayDown(x + 0.5, b.y, z + 0.5, MAX_DEPTH_RAY, { liquids: false, skipTypes: WATER_PLANT_TYPES });
      out.d = floor ? Math.max(0, Math.min(63, b.y - floor.y)) : MAX_DEPTH_RAY;
    }
    return;
  }
  out.h = b.y + 1;
  out.c = isSnow(b.typeId) ? SNOW_COLOR : blockColor(b);
  out.f = isFoliage(b.typeId) ? F_FOLIAGE : isSnow(b.typeId) ? F_SNOW : 0;
}

/**
 * Samples one chunk on a res×res grid (cell centres). Yields between small slices of work.
 * Returns null when the chunk is not loaded or any host call fails (the caller retries later).
 */
export function* sampleChunk(
  dim: HostDimension,
  cx: number,
  cz: number,
  res: number,
  opts: SamplerOptions,
): Generator<void, ChunkLod | null, void> {
  const x0 = cx * 16;
  const z0 = cz * 16;
  if (!dim.isChunkLoaded(x0 + 8, z0 + 8)) return null;
  const lod = new ChunkLod(res);
  const base = lod.base;
  const n = base.n;
  const half = res >> 1;
  const s: Sample = { h: 0, c: 0, f: 0, d: 0 };
  let done = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      try {
        sampleColumn(dim, x0 + i * res + half, z0 + j * res + half, opts, s);
      } catch {
        return null;
      }
      const k = i + j * n;
      base.height[k] = s.h;
      base.color[k] = s.c;
      base.flags[k] = s.f;
      base.depth[k] = s.d;
      if (++done % SAMPLES_PER_SLICE === 0) yield;
    }
  }
  lod.buildMips();
  return lod;
}

export { WATER_FALLBACK, SNOW_COLOR };
