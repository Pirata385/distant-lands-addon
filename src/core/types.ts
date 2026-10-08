/** Interfaces between the pure core and the game. The bedrock/ layer implements these. */

/** Minimal key/value persistence (world dynamic properties in game). */
export interface KV {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
  keys(): string[];
  totalBytes(): number;
}

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
  // Some events report ids without the namespace.
  switch (id.includes(':') ? id : `minecraft:${id}`) {
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

/** Molang variable names shared by the script and the LOD particle definitions. */
export const MOLANG = {
  ox: 'variable.ox',
  oy: 'variable.oy',
  oz: 'variable.oz',
  a: 'variable.sa',
  b: 'variable.sb',
  r: 'variable.cr',
  g: 'variable.cg',
  bl: 'variable.cb',
  life: 'variable.life',
  l0: 'variable.l0',
  dl: 'variable.dl',
  grow: 'variable.grow',
} as const;

export const EFFECT_TOP = 'dl:lod_top';
export const EFFECT_WALL = 'dl:lod_wall';

export interface HostPlayer {
  readonly id: string;
  readonly name: string;
  isValid(): boolean;
  dimension(): HostDimension;
  location(): Vec3;
  eye(): Vec3;
  viewDirection(): Vec3;
  /** Flying or gliding. */
  isFlying(): boolean;
  isOperator(): boolean;
  /** Spawns a particle only this player sees. Throws when the location is not usable. */
  spawnParticle(effect: string, at: Vec3, vars: Readonly<Record<keyof typeof MOLANG, number>>): void;
  /** Runs a command as this player (fog). Returns false on failure. */
  runCommand(cmd: string): boolean;
  actionBar(text: string): void;
  tell(text: string): void;
  /** Client graphics mode name when known (e.g. 'Deferred' for Vibrant Visuals). */
  graphicsMode(): string | undefined;
  /** Client memory tier 0..4 when known. */
  memoryTier(): number | undefined;
  /** Device max render distance in chunks when known. */
  maxRenderDistance(): number | undefined;
  /** Dynamic property storage on the player. */
  loadData(key: string): string | undefined;
  saveData(key: string, value: string | undefined): void;
}

/** World-level services the core needs. */
export interface Host {
  players(): HostPlayer[];
  /** 0 overworld, 1 nether, 2 the end. */
  dimension(index: number): HostDimension | undefined;
  readonly kv: KV;
  currentTick(): number;
  /** Ticks since sunrise 0..24000. */
  timeOfDay(): number;
  dayCycle(): boolean;
  /** Milliseconds, for time budgets. */
  clock(): number;
  log(message: string): void;
}
