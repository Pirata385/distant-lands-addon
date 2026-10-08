/**
 * Deterministic procedural terrain used by the tests and the fake Bedrock runtime.
 * Columns are described top-down; everything below the listed blocks is stone, above is air.
 */
import type { HostBlock, HostDimension, RGBf, RayDownOptions } from '../../src/core/types';

export const SEA_LEVEL = 62;

export interface ColumnBlock {
  y: number;
  typeId: string;
}

export interface Column {
  /** Listed blocks, highest first. */
  blocks: ColumnBlock[];
  /** Ground surface block Y (top solid terrain, excluding trees/decorations/water). */
  ground: number;
}

export function hash2(x: number, z: number, seed = 1337): number {
  let h = (x * 374761393 + z * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothNoise(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Ground height of the default world: rolling hills, a few mountains and oceans. */
export function groundHeight(x: number, z: number): number {
  const base = smoothNoise(x, z, 160, 1) * 40 - 8;
  const hills = smoothNoise(x, z, 48, 2) * 14;
  const mountains = Math.max(0, smoothNoise(x, z, 300, 3) - 0.55) * 260;
  return Math.floor(52 + base + hills + mountains);
}

export function defaultColumn(x: number, z: number): Column {
  const g = groundHeight(x, z);
  const blocks: ColumnBlock[] = [];
  if (g < SEA_LEVEL) {
    for (let y = SEA_LEVEL; y > g; y--) blocks.push({ y, typeId: 'minecraft:water' });
    blocks.push({ y: g, typeId: g < SEA_LEVEL - 4 ? 'minecraft:gravel' : 'minecraft:sand' });
    return { blocks, ground: g };
  }
  const r = hash2(x, z, 7);
  const forest = smoothNoise(x, z, 90, 5) > 0.55;
  if (g > 110) {
    blocks.push({ y: g + 1, typeId: 'minecraft:snow_layer' });
    blocks.push({ y: g, typeId: 'minecraft:stone' });
    return { blocks, ground: g };
  }
  if (forest && hash2(Math.floor(x / 3), Math.floor(z / 3), 11) < 0.35) {
    // Tree canopy (leaves 4-6 above ground) with a log underneath.
    const top = g + 4 + Math.floor(hash2(Math.floor(x / 3), Math.floor(z / 3), 12) * 3);
    blocks.push({ y: top, typeId: 'minecraft:oak_leaves' });
    blocks.push({ y: top - 1, typeId: 'minecraft:oak_leaves' });
    for (let y = top - 2; y > g; y--) blocks.push({ y, typeId: 'minecraft:oak_log' });
  } else if (r < 0.15) {
    blocks.push({ y: g + 1, typeId: 'minecraft:short_grass' });
  } else if (r < 0.17) {
    blocks.push({ y: g + 1, typeId: 'minecraft:poppy' });
  }
  blocks.push({ y: g, typeId: g < SEA_LEVEL + 2 ? 'minecraft:sand' : 'minecraft:grass_block' });
  blocks.push({ y: g - 1, typeId: 'minecraft:dirt' });
  return { blocks, ground: g };
}

/** Biome-like grass tint varying slowly across the world. */
export function grassTint(x: number, z: number): RGBf {
  const t = smoothNoise(x, z, 400, 9);
  return { red: 0.45 + 0.25 * t, green: 0.72 - 0.1 * t, blue: 0.3 + 0.05 * t };
}

const TINTED = new Set(['minecraft:grass_block', 'minecraft:oak_leaves', 'minecraft:short_grass', 'minecraft:water']);
const BASE_MAP: RGBf = { red: 0.6, green: 0.6, blue: 0.6 };

export class FakeBlock implements HostBlock {
  constructor(
    private readonly dim: FakeDimension,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly typeId: string,
  ) {}

  below(): HostBlock | undefined {
    if (this.y - 1 < this.dim.minY) return undefined;
    return this.dim.blockAt(this.x, this.y - 1, this.z);
  }

  mapColor(): { base: RGBf; tinted: RGBf } | undefined {
    this.dim.mapColorCalls++;
    if (this.typeId === 'minecraft:air') return undefined;
    if (!TINTED.has(this.typeId)) return { base: BASE_MAP, tinted: BASE_MAP };
    const t = this.typeId === 'minecraft:water' ? { red: 0.25, green: 0.45, blue: 0.9 } : grassTint(this.x, this.z);
    return {
      base: BASE_MAP,
      tinted: { red: BASE_MAP.red * t.red, green: BASE_MAP.green * t.green, blue: BASE_MAP.blue * t.blue },
    };
  }
}

export class FakeDimension implements HostDimension {
  readonly minY = -64;
  readonly maxY = 320;
  mapColorCalls = 0;
  topmostCalls = 0;
  commands: string[] = [];
  /** null = every chunk loaded. */
  loaded: Set<string> | null = null;
  /** Columns kept in the memo before it is cleared (perf runs keep it small so it does not dominate the heap). */
  cacheLimit = 200000;
  private cache = new Map<string, Column>();

  constructor(
    readonly id = 'minecraft:overworld',
    readonly index = 0,
    private readonly columnFn: (x: number, z: number) => Column | undefined = defaultColumn,
  ) {}

  column(x: number, z: number): Column | undefined {
    const key = `${x},${z}`;
    let c = this.cache.get(key);
    if (c === undefined) {
      c = this.columnFn(x, z);
      if (c) {
        if (this.cache.size > this.cacheLimit) this.cache.clear();
        this.cache.set(key, c);
      }
    }
    return c;
  }

  isChunkLoaded(x: number, z: number): boolean {
    if (!this.loaded) return true;
    return this.loaded.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  }

  private check(x: number, z: number): void {
    if (!this.isChunkLoaded(x, z)) throw new Error('LocationInUnloadedChunkError');
  }

  blockAt(x: number, y: number, z: number): FakeBlock {
    const c = this.column(x, z);
    if (!c) return new FakeBlock(this, x, y, z, 'minecraft:air');
    const top = c.blocks.length ? c.blocks[0].y : c.ground;
    if (y > top) return new FakeBlock(this, x, y, z, 'minecraft:air');
    for (const b of c.blocks) if (b.y === y) return new FakeBlock(this, x, y, z, b.typeId);
    const lowest = c.blocks.length ? c.blocks[c.blocks.length - 1].y : c.ground + 1;
    if (y < lowest) return new FakeBlock(this, x, y, z, y <= this.minY ? 'minecraft:bedrock' : 'minecraft:stone');
    return new FakeBlock(this, x, y, z, 'minecraft:air');
  }

  topmost(x: number, z: number): HostBlock | undefined {
    this.check(x, z);
    this.topmostCalls++;
    const c = this.column(x, z);
    if (!c) return undefined;
    const top = c.blocks.length ? c.blocks[0] : { y: c.ground, typeId: 'minecraft:stone' };
    return new FakeBlock(this, x, top.y, z, top.typeId);
  }

  rayDown(x: number, y: number, z: number, maxDistance: number, opts: RayDownOptions): HostBlock | undefined {
    this.check(x, z);
    const skip = new Set(opts.skipTypes ?? []);
    for (let yy = Math.floor(y); yy >= Math.floor(y) - maxDistance && yy >= this.minY; yy--) {
      const b = this.blockAt(x, yy, z);
      if (b.typeId === 'minecraft:air' || skip.has(b.typeId)) continue;
      if (!opts.liquids && (b.typeId === 'minecraft:water' || b.typeId === 'minecraft:lava')) continue;
      if (['minecraft:short_grass', 'minecraft:poppy', 'minecraft:snow_layer'].includes(b.typeId)) continue;
      return b;
    }
    return undefined;
  }

  skyLight(): number {
    return 15;
  }

  command(cmd: string): boolean {
    this.commands.push(cmd);
    return true;
  }
}
