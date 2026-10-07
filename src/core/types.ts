/** Interfaces between the pure core and the game. The bedrock/ layer implements these. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Colour with 0..1 channels (Script API RGB). */
export interface RGBf {
  red: number;
  green: number;
  blue: number;
}

export interface HostBlock {
  readonly typeId: string;
  readonly y: number;
  below(): HostBlock | undefined;
  /** The block's map colour before (`base`) and after (`tinted`) biome tinting, when it has one. */
  mapColor(): { base: RGBf; tinted: RGBf } | undefined;
}

export interface RayDownOptions {
  /** Stop at liquids (true) or pass through them (false). */
  liquids: boolean;
  /** Block types the ray passes through. */
  skipTypes?: readonly string[];
}

export interface HostDimension {
  /** Dimension identifier, e.g. `minecraft:overworld`. */
  readonly id: string;
  /** Compact index used in storage keys: 0 overworld, 1 nether, 2 the end. */
  readonly index: number;
  readonly minY: number;
  readonly maxY: number;
  /** True when the chunk containing block (x, z) is loaded and usable. */
  isChunkLoaded(x: number, z: number): boolean;
  /** Highest non-air block of the column, or undefined for an empty (void) column. Throws if unloaded. */
  topmost(x: number, z: number): HostBlock | undefined;
  /** First block at or below (x, y, z) not skipped by the options, within maxDistance. Throws if unloaded. */
  rayDown(x: number, y: number, z: number, maxDistance: number, opts: RayDownOptions): HostBlock | undefined;
  /** Sky light (0..15) at a block position; 15 when unknown. */
  skyLight(x: number, y: number, z: number): number;
  /** Runs a command in this dimension; returns false when it failed. */
  command(cmd: string): boolean;
}

export function dimensionIndex(id: string): number {
  switch (id) {
    case 'minecraft:overworld':
      return 0;
    case 'minecraft:nether':
      return 1;
    case 'minecraft:the_end':
      return 2;
    default:
      return 3;
  }
}
