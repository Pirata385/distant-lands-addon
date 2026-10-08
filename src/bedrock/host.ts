/**
 * Adapters from the Minecraft Script API (@minecraft/server 2.5.0, Bedrock 26.3+) to the core host interfaces.
 * This is the only module (with ui/commands/main) that touches the game API.
 */
import {
  Block,
  Dimension,
  MolangVariableMap,
  Player,
  PlayerPermissionLevel,
  RawMessage,
  TintMethod,
  system,
  world,
} from '@minecraft/server';
import type { Host, HostBlock, HostDimension, HostPlayer, KV, MOLANG as MolangNames, RayDownOptions, RGBf, Vec3 } from '../core/types';
import { MOLANG, dimensionIndex } from '../core/types';

const DIMENSION_IDS = ['minecraft:overworld', 'minecraft:nether', 'minecraft:the_end'];
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

interface MapColorInfo {
  base: RGBf;
  tinted: boolean;
}

/** Per block type: map colour base and whether it is biome-tinted (null: no map colour). */
const mapColorCache = new Map<string, MapColorInfo | null>();

function readMapColor(block: Block): { base: RGBf; tinted: RGBf } | undefined {
  const type = block.typeId;
  let info = mapColorCache.get(type);
  if (info === null) return undefined;
  if (info === undefined) {
    let comp;
    try {
      comp = block.getComponent('minecraft:map_color');
    } catch {
      comp = undefined;
    }
    if (!comp) {
      mapColorCache.set(type, null);
      return undefined;
    }
    let tinted = true;
    try {
      tinted = comp.tintMethod !== TintMethod.None;
    } catch {
      tinted = true;
    }
    info = { base: { red: comp.color.red, green: comp.color.green, blue: comp.color.blue }, tinted };
    mapColorCache.set(type, info);
    if (!tinted) return { base: info.base, tinted: info.base };
    return { base: info.base, tinted: comp.tintedColor };
  }
  if (!info.tinted) return { base: info.base, tinted: info.base };
  const comp = block.getComponent('minecraft:map_color');
  return comp ? { base: info.base, tinted: comp.tintedColor } : undefined;
}

class BedrockBlock implements HostBlock {
  readonly typeId: string;
  readonly y: number;

  constructor(private readonly block: Block) {
    this.typeId = block.typeId;
    this.y = block.y;
  }

  below(): HostBlock | undefined {
    const b = this.block.below();
    return b ? new BedrockBlock(b) : undefined;
  }

  mapColor(): { base: RGBf; tinted: RGBf } | undefined {
    return readMapColor(this.block);
  }
}

export class BedrockDimension implements HostDimension {
  readonly id: string;
  readonly index: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(readonly dim: Dimension) {
    this.id = dim.id;
    this.index = dimensionIndex(dim.id);
    this.minY = dim.heightRange.min;
    this.maxY = dim.heightRange.max;
  }

  isChunkLoaded(x: number, z: number): boolean {
    return this.dim.isChunkLoaded({ x, y: this.minY + 1, z });
  }

  topmost(x: number, z: number): HostBlock | undefined {
    const b = this.dim.getTopmostBlock({ x, z });
    return b ? new BedrockBlock(b) : undefined;
  }

  rayDown(x: number, y: number, z: number, maxDistance: number, opts: RayDownOptions): HostBlock | undefined {
    const hit = this.dim.getBlockFromRay({ x, y: y + 0.5, z }, DOWN, {
      includeLiquidBlocks: opts.liquids,
      includePassableBlocks: false,
      maxDistance,
      excludeTypes: opts.skipTypes ? [...opts.skipTypes] : undefined,
    });
    return hit ? new BedrockBlock(hit.block) : undefined;
  }

  skyLight(x: number, y: number, z: number): number {
    if (y < this.minY || y >= this.maxY) return 15;
    return this.dim.getSkyLightLevel({ x, y, z });
  }

  command(cmd: string): boolean {
    try {
      return this.dim.runCommand(cmd).successCount > 0;
    } catch {
      return false;
    }
  }
}

/** Translation keys (dl.*) are sent as translated raw messages. */
export function message(text: string): RawMessage | string {
  return /^dl\.[a-z0-9_.]+$/.test(text) ? { translate: text } : text;
}

export class BedrockPlayer implements HostPlayer {
  readonly id: string;
  readonly name: string;

  constructor(
    public player: Player,
    private readonly host: BedrockHost,
  ) {
    this.id = player.id;
    this.name = player.name;
  }

  isValid(): boolean {
    return this.player.isValid;
  }

  dimension(): HostDimension {
    return this.host.wrapDimension(this.player.dimension);
  }

  location(): Vec3 {
    return this.player.location;
  }

  eye(): Vec3 {
    return this.player.getHeadLocation();
  }

  viewDirection(): Vec3 {
    return this.player.getViewDirection();
  }

  isFlying(): boolean {
    return this.player.isFlying || this.player.isGliding;
  }

  isOperator(): boolean {
    try {
      // Custom (3) is a restricted member with individually chosen abilities, not an operator.
      return this.player.playerPermissionLevel === PlayerPermissionLevel.Operator;
    } catch {
      return false;
    }
  }

  spawnParticle(effect: string, at: Vec3, vars: Readonly<Record<keyof typeof MolangNames, number>>): void {
    const m = this.host.molang;
    m.setFloat(MOLANG.ox, vars.ox);
    m.setFloat(MOLANG.oy, vars.oy);
    m.setFloat(MOLANG.oz, vars.oz);
    m.setFloat(MOLANG.a, vars.a);
    m.setFloat(MOLANG.b, vars.b);
    m.setFloat(MOLANG.r, vars.r);
    m.setFloat(MOLANG.g, vars.g);
    m.setFloat(MOLANG.bl, vars.bl);
    m.setFloat(MOLANG.life, vars.life);
    m.setFloat(MOLANG.l0, vars.l0);
    m.setFloat(MOLANG.dl, vars.dl);
    m.setFloat(MOLANG.grow, vars.grow);
    this.player.spawnParticle(effect, at, m);
  }

  runCommand(cmd: string): boolean {
    try {
      return this.player.runCommand(cmd).successCount > 0;
    } catch {
      return false;
    }
  }

  actionBar(text: string): void {
    this.player.onScreenDisplay.setActionBar(text);
  }

  tell(text: string): void {
    this.player.sendMessage(message(text));
  }

  graphicsMode(): string | undefined {
    try {
      return String(this.player.graphicsMode);
    } catch {
      return undefined;
    }
  }

  memoryTier(): number | undefined {
    try {
      return this.player.clientSystemInfo.memoryTier;
    } catch {
      return undefined;
    }
  }

  maxRenderDistance(): number | undefined {
    try {
      return this.player.clientSystemInfo.maxRenderDistance;
    } catch {
      return undefined;
    }
  }

  loadData(key: string): string | undefined {
    const v = this.player.getDynamicProperty(key);
    return typeof v === 'string' ? v : undefined;
  }

  saveData(key: string, value: string | undefined): void {
    this.player.setDynamicProperty(key, value);
  }
}

const worldKV: KV = {
  get(key) {
    const v = world.getDynamicProperty(key);
    return typeof v === 'string' ? v : undefined;
  },
  set(key, value) {
    world.setDynamicProperty(key, value);
  },
  keys() {
    return world.getDynamicPropertyIds();
  },
  totalBytes() {
    return world.getDynamicPropertyTotalByteCount();
  },
};

export class BedrockHost implements Host {
  readonly kv = worldKV;
  /** Reused for every particle spawn (values are read synchronously by the engine). */
  readonly molang = new MolangVariableMap();
  private readonly dims = new Map<string, BedrockDimension>();
  private readonly wrappers = new Map<string, BedrockPlayer>();

  wrapDimension(d: Dimension): BedrockDimension {
    let w = this.dims.get(d.id);
    if (!w) {
      w = new BedrockDimension(d);
      this.dims.set(d.id, w);
    }
    return w;
  }

  wrapPlayer(p: Player): BedrockPlayer {
    let w = this.wrappers.get(p.id);
    if (!w) {
      w = new BedrockPlayer(p, this);
      this.wrappers.set(p.id, w);
    } else {
      w.player = p;
    }
    return w;
  }

  forgetPlayer(id: string): void {
    this.wrappers.delete(id);
  }

  players(): HostPlayer[] {
    return world.getAllPlayers().map((p) => this.wrapPlayer(p));
  }

  dimension(index: number): HostDimension | undefined {
    const id = DIMENSION_IDS[index];
    if (!id) return undefined;
    try {
      return this.wrapDimension(world.getDimension(id));
    } catch {
      return undefined;
    }
  }

  currentTick(): number {
    return system.currentTick;
  }

  timeOfDay(): number {
    return world.getTimeOfDay();
  }

  dayCycle(): boolean {
    try {
      return world.gameRules.doDayLightCycle;
    } catch {
      return true;
    }
  }

  clock(): number {
    return Date.now();
  }

  log(text: string): void {
    console.warn(text);
  }
}
