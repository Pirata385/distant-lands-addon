/**
 * Fake `@minecraft/server` (2.5.0 subset used by Distant Lands) for end-to-end simulation of the production bundle.
 * Emulates: tick scheduling (run/runInterval/runTimeout/runJob/waitTicks), events, world + player dynamic properties
 * (with the 32 767 character limit), chunk loading around players and ticking areas, /fog stacks, terrain queries,
 * map colours, and a per-player client particle store with lifetimes and particle_expire_if_in_blocks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultColumn, Column, grassTint, SEA_LEVEL } from './terrain';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------------------------- enums

export enum PlayerPermissionLevel {
  Visitor = 0,
  Member = 1,
  Operator = 2,
  Custom = 3,
}
export enum CommandPermissionLevel {
  Any = 0,
  GameDirectors = 1,
  Admin = 2,
  Host = 3,
  Owner = 4,
}
export enum CustomCommandParamType {
  Boolean = 'Boolean',
  Enum = 'Enum',
  Float = 'Float',
  Integer = 'Integer',
  String = 'String',
}
export enum CustomCommandStatus {
  Success = 0,
  Failure = 1,
}
export enum TintMethod {
  BirchFoliage = 'BirchFoliage',
  DefaultFoliage = 'DefaultFoliage',
  DryFoliage = 'DryFoliage',
  EvergreenFoliage = 'EvergreenFoliage',
  Grass = 'Grass',
  None = 'None',
  Water = 'Water',
}

// ---------------------------------------------------------------------------------------------- events

class Signal<T> {
  handlers: Array<(e: T) => void> = [];
  subscribe(cb: (e: T) => void) {
    this.handlers.push(cb);
    return cb;
  }
  unsubscribe(cb: (e: T) => void) {
    this.handlers = this.handlers.filter((h) => h !== cb);
  }
  fire(e: T) {
    for (const h of [...this.handlers]) {
      try {
        h(e);
      } catch (err) {
        fake.uncaught.push(err);
      }
    }
  }
}

export class LocationInUnloadedChunkError extends Error {
  constructor() {
    super('LocationInUnloadedChunkError');
    this.name = 'LocationInUnloadedChunkError';
  }
}

// ---------------------------------------------------------------------------------------------- molang

export class MolangVariableMap {
  values = new Map<string, number>();
  setFloat(name: string, value: number) {
    if (!Number.isFinite(value)) throw new Error(`non-finite molang value for ${name}`);
    this.values.set(name, value);
  }
  setColorRGB() {}
  setColorRGBA() {}
  setSpeedAndDirection() {}
  setVector3() {}
}

// ---------------------------------------------------------------------------------------------- terrain

const MAP_BASE = { red: 0.6, green: 0.6, blue: 0.6, alpha: 1 };
const TINTED: Record<string, TintMethod> = {
  'minecraft:grass_block': TintMethod.Grass,
  'minecraft:oak_leaves': TintMethod.DefaultFoliage,
  'minecraft:short_grass': TintMethod.Grass,
  'minecraft:water': TintMethod.Water,
};

export class Block {
  constructor(
    readonly dimension: Dimension,
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly typeId: string,
  ) {}
  get location(): Vector3 {
    return { x: this.x, y: this.y, z: this.z };
  }
  get isValid() {
    return true;
  }
  below(): Block | undefined {
    if (this.y - 1 < this.dimension.heightRange.min) return undefined;
    return this.dimension.blockAt(this.x, this.y - 1, this.z);
  }
  getComponent(id: string): any {
    if (id !== 'minecraft:map_color' || this.typeId === 'minecraft:air') return undefined;
    fake.stats.mapColorReads++;
    const method = TINTED[this.typeId] ?? TintMethod.None;
    let tinted = MAP_BASE;
    if (method === TintMethod.Water) tinted = { red: 0.15, green: 0.27, blue: 0.54, alpha: 1 };
    else if (method !== TintMethod.None) {
      const t = grassTint(this.x, this.z);
      tinted = { red: MAP_BASE.red * t.red, green: MAP_BASE.green * t.green, blue: MAP_BASE.blue * t.blue, alpha: 1 };
    }
    return { color: MAP_BASE, tintedColor: tinted, tintMethod: method };
  }
}

export class Dimension {
  readonly heightRange: { min: number; max: number };
  private cache = new Map<string, Column | undefined>();
  constructor(
    readonly id: string,
    private readonly columnFn: (x: number, z: number) => Column | undefined,
    min = -64,
    max = 320,
  ) {
    this.heightRange = { min, max };
  }

  column(x: number, z: number): Column | undefined {
    const k = `${x},${z}`;
    if (!this.cache.has(k)) {
      if (this.cache.size > 400000) this.cache.clear();
      this.cache.set(k, this.columnFn(x, z));
    }
    return this.cache.get(k);
  }

  blockAt(x: number, y: number, z: number): Block {
    const c = this.column(x, z);
    if (!c) return new Block(this, x, y, z, 'minecraft:air');
    const top = c.blocks.length ? c.blocks[0].y : c.ground;
    if (y > top) return new Block(this, x, y, z, 'minecraft:air');
    for (const b of c.blocks) if (b.y === y) return new Block(this, x, y, z, b.typeId);
    const lowest = c.blocks.length ? c.blocks[c.blocks.length - 1].y : c.ground + 1;
    if (y < lowest) return new Block(this, x, y, z, y <= this.heightRange.min ? 'minecraft:bedrock' : 'minecraft:stone');
    return new Block(this, x, y, z, 'minecraft:air');
  }

  private ensureLoaded(x: number, z: number) {
    if (!fake.serverLoaded(this, Math.floor(x / 16), Math.floor(z / 16))) throw new LocationInUnloadedChunkError();
  }

  isChunkLoaded(loc: Vector3): boolean {
    fake.stats.isChunkLoaded++;
    return fake.serverLoaded(this, Math.floor(loc.x / 16), Math.floor(loc.z / 16));
  }

  getTopmostBlock(loc: { x: number; z: number }): Block | undefined {
    const x = Math.floor(loc.x);
    const z = Math.floor(loc.z);
    this.ensureLoaded(x, z);
    fake.stats.topmost++;
    const c = this.column(x, z);
    if (!c) return undefined;
    const top = c.blocks.length ? c.blocks[0] : { y: c.ground, typeId: 'minecraft:stone' };
    return new Block(this, x, top.y, z, top.typeId);
  }

  getBlock(loc: Vector3): Block | undefined {
    if (!fake.serverLoaded(this, Math.floor(loc.x / 16), Math.floor(loc.z / 16))) return undefined;
    return this.blockAt(Math.floor(loc.x), Math.floor(loc.y), Math.floor(loc.z));
  }

  getBlockFromRay(loc: Vector3, dir: Vector3, opts: any = {}): { block: Block; face: string; faceLocation: Vector3 } | undefined {
    if (dir.x !== 0 || dir.z !== 0 || dir.y >= 0) throw new Error('fake only supports straight-down rays');
    const x = Math.floor(loc.x);
    const z = Math.floor(loc.z);
    this.ensureLoaded(x, z);
    fake.stats.rays++;
    const exclude = new Set<string>(opts.excludeTypes ?? []);
    const max = opts.maxDistance ?? 400;
    for (let y = Math.floor(loc.y); y >= Math.floor(loc.y) - max && y >= this.heightRange.min; y--) {
      const b = this.blockAt(x, y, z);
      if (b.typeId === 'minecraft:air' || exclude.has(b.typeId)) continue;
      const liquid = b.typeId === 'minecraft:water' || b.typeId === 'minecraft:lava';
      if (liquid && !opts.includeLiquidBlocks) continue;
      const passable = ['minecraft:short_grass', 'minecraft:poppy', 'minecraft:snow_layer'].includes(b.typeId);
      if (passable && !opts.includePassableBlocks) continue;
      return { block: b, face: 'Up', faceLocation: { x: 0.5, y: 1, z: 0.5 } };
    }
    return undefined;
  }

  getSkyLightLevel(loc: Vector3): number {
    this.ensureLoaded(Math.floor(loc.x), Math.floor(loc.z));
    const c = this.column(Math.floor(loc.x), Math.floor(loc.z));
    if (!c) return 15;
    return loc.y < c.ground - 2 ? 0 : 15;
  }

  runCommand(cmd: string): { successCount: number } {
    return { successCount: fake.command(this, undefined, cmd) ? 1 : 0 };
  }

  spawnParticle(): void {
    throw new Error('Distant Lands must use Player.spawnParticle');
  }
}

// ---------------------------------------------------------------------------------------------- players

export interface ClientParticle {
  effect: string;
  x: number;
  y: number;
  z: number;
  vars: Map<string, number>;
  born: number;
  dieAt: number;
}

export class Player {
  readonly id: string;
  name: string;
  location: Vector3;
  dimension: Dimension;
  isValid = true;
  isFlying = false;
  isGliding = false;
  playerPermissionLevel = PlayerPermissionLevel.Operator;
  commandPermissionLevel = CommandPermissionLevel.Admin;
  graphicsMode = 'Fancy';
  clientSystemInfo = { maxRenderDistance: 32, memoryTier: 3, platformType: 'Desktop' };
  viewDirection: Vector3 = { x: 0, y: 0, z: 1 };
  readonly props = new Map<string, unknown>();
  readonly particles: ClientParticle[] = [];
  readonly fogStack: Array<{ fog: string; id: string }> = [];
  readonly messages: unknown[] = [];
  readonly actionBars: unknown[] = [];
  readonly commands: string[] = [];
  spawnedTotal = 0;
  spawnedThisTick = 0;
  spawnFailures = 0;
  /** Chunks the client has (render distance). */
  viewRadius: number;
  readonly onScreenDisplay = {
    setActionBar: (text: unknown) => {
      this.actionBars.push(text);
    },
  };

  constructor(id: string, name: string, dim: Dimension, loc: Vector3, viewRadius: number) {
    this.id = id;
    this.name = name;
    this.dimension = dim;
    this.location = loc;
    this.viewRadius = viewRadius;
  }

  getHeadLocation(): Vector3 {
    return { x: this.location.x, y: this.location.y + 1.62, z: this.location.z };
  }
  getViewDirection(): Vector3 {
    return { ...this.viewDirection };
  }
  getRotation() {
    return { x: 0, y: 0 };
  }
  getVelocity() {
    return { x: 0, y: 0, z: 0 };
  }
  getDynamicProperty(key: string) {
    return this.props.get(key);
  }
  setDynamicProperty(key: string, value?: unknown) {
    if (typeof value === 'string' && value.length > 32767) throw new Error('dynamic property too long');
    if (value === undefined) this.props.delete(key);
    else this.props.set(key, value);
  }
  sendMessage(m: unknown) {
    this.messages.push(m);
  }
  runCommand(cmd: string): { successCount: number } {
    this.commands.push(cmd);
    return { successCount: fake.command(this.dimension, this, cmd) ? 1 : 0 };
  }

  spawnParticle(effect: string, location: Vector3, molang?: MolangVariableMap): void {
    fake.stats.spawnCalls++;
    const def = fake.particleDefs.get(effect);
    if (!def) throw new Error(`unknown particle ${effect}`);
    if (location.y < this.dimension.heightRange.min || location.y >= this.dimension.heightRange.max) {
      throw new Error('LocationOutOfWorldBoundariesError');
    }
    if (!fake.serverLoaded(this.dimension, Math.floor(location.x / 16), Math.floor(location.z / 16))) {
      this.spawnFailures++;
      throw new LocationInUnloadedChunkError();
    }
    const vars = new Map(molang?.values ?? []);
    for (const v of def.vars) if (!vars.has(v)) throw new Error(`particle ${effect} variable ${v} not set`);
    const life = vars.get('variable.life') ?? 0;
    this.particles.push({
      effect,
      x: location.x + (vars.get('variable.ox') ?? 0),
      y: location.y + (vars.get('variable.oy') ?? 0),
      z: location.z + (vars.get('variable.oz') ?? 0),
      vars,
      born: fake.tick,
      dieAt: fake.tick + Math.round(life * 20),
    });
    this.spawnedTotal++;
    this.spawnedThisTick++;
  }

  /** Chunk coordinates the client has loaded (circle of viewRadius around the player). */
  clientHas(cx: number, cz: number): boolean {
    const pcx = Math.floor(this.location.x / 16);
    const pcz = Math.floor(this.location.z / 16);
    return (cx - pcx) ** 2 + (cz - pcz) ** 2 <= this.viewRadius ** 2;
  }
}

// ---------------------------------------------------------------------------------------------- system

interface Timer {
  id: number;
  at: number;
  every: number;
  cb: () => void;
}

class FakeSystem {
  readonly beforeEvents = { startup: new Signal<any>(), shutdown: new Signal<any>() };
  readonly afterEvents = { scriptEventReceive: new Signal<any>() };
  timers: Timer[] = [];
  jobs = new Map<number, Generator<void, void, void>>();
  nextId = 1;
  get currentTick() {
    return fake.tick;
  }
  run(cb: () => void) {
    return this.add(cb, 1, 0);
  }
  runTimeout(cb: () => void, delay = 1) {
    return this.add(cb, Math.max(1, delay), 0);
  }
  runInterval(cb: () => void, every = 1) {
    return this.add(cb, Math.max(1, every), Math.max(1, every));
  }
  private add(cb: () => void, delay: number, every: number) {
    const id = this.nextId++;
    this.timers.push({ id, at: fake.tick + delay, every, cb });
    return id;
  }
  clearRun(id: number) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  runJob(g: Generator<void, void, void>) {
    const id = this.nextId++;
    this.jobs.set(id, g);
    return id;
  }
  clearJob(id: number) {
    this.jobs.delete(id);
  }
  waitTicks(n: number): Promise<void> {
    return new Promise((resolve) => this.runTimeout(() => resolve(), n));
  }
  sendScriptEvent(id: string, message: string) {
    this.afterEvents.scriptEventReceive.fire({ id, message, sourceType: 'Server' });
  }
}

// ---------------------------------------------------------------------------------------------- world

class FakeWorld {
  readonly afterEvents = {
    worldLoad: new Signal<any>(),
    playerSpawn: new Signal<any>(),
    playerLeave: new Signal<any>(),
    playerDimensionChange: new Signal<any>(),
    playerBreakBlock: new Signal<any>(),
    playerPlaceBlock: new Signal<any>(),
    pistonActivate: new Signal<any>(),
    explosion: new Signal<any>(),
    weatherChange: new Signal<any>(),
    itemUse: new Signal<any>(),
  };
  readonly gameRules = { doDayLightCycle: true };
  props = new Map<string, unknown>();
  getDynamicProperty(key: string) {
    return this.props.get(key);
  }
  setDynamicProperty(key: string, value?: unknown) {
    fake.stats.worldWrites++;
    if (typeof value === 'string' && value.length > 32767) throw new Error(`dynamic property ${key} too long (${value.length})`);
    if (value === undefined) this.props.delete(key);
    else this.props.set(key, value);
  }
  getDynamicPropertyIds() {
    return [...this.props.keys()];
  }
  getDynamicPropertyTotalByteCount() {
    let n = 0;
    for (const [k, v] of this.props) n += k.length + (typeof v === 'string' ? v.length : 8);
    return n;
  }
  getAllPlayers(): Player[] {
    return fake.players.filter((p) => p.isValid);
  }
  getPlayers(): Player[] {
    return this.getAllPlayers();
  }
  getDimension(id: string): Dimension {
    const short = id.replace('minecraft:', '');
    const d = fake.dimensions.get(short === 'nether' ? 'nether' : short === 'the_end' ? 'the_end' : 'overworld');
    if (!d) throw new Error(`no dimension ${id}`);
    return d;
  }
  getTimeOfDay() {
    return fake.timeOfDay;
  }
  getAbsoluteTime() {
    return fake.tick;
  }
}

// ---------------------------------------------------------------------------------------------- controller

interface ParticleDef {
  vars: string[];
  expire: Set<string>;
}

function loadParticleDefs(): Map<string, ParticleDef> {
  const root = join(import.meta.dirname, '..', '..', 'packs', 'resource_pack', 'particles');
  const defs = new Map<string, ParticleDef>();
  for (const f of ['lod_top.json', 'lod_wall.json']) {
    const p = JSON.parse(readFileSync(join(root, f), 'utf8')).particle_effect;
    const text = JSON.stringify(p.components);
    const vars = [...new Set([...text.matchAll(/\bv\.([a-z0-9_]+)/g)].map((m) => m[1]))]
      .filter((n) => !['particle_age', 'k', 'lit'].includes(n))
      .map((n) => `variable.${n}`);
    defs.set(p.description.identifier, { vars, expire: new Set(p.components['minecraft:particle_expire_if_in_blocks'] ?? []) });
  }
  return defs;
}

export interface FakeOptions {
  viewRadius?: number;
  /** Ticks until a ticking area's chunks load. */
  areaDelay?: number;
  /** Max steps a runJob generator gets per tick. */
  jobStepsPerTick?: number;
  overworld?: (x: number, z: number) => Column | undefined;
  /** Keep world dynamic properties from the previous run (world reload). */
  keepWorldProps?: boolean;
}

class Controller {
  tick = 0;
  timeOfDay = 6000;
  players: Player[] = [];
  dimensions = new Map<string, Dimension>();
  areas = new Map<string, { dim: Dimension; x1: number; z1: number; x2: number; z2: number; since: number }>();
  maxAreas = 0;
  areaAdds = 0;
  uncaught: unknown[] = [];
  logs: string[] = [];
  particleDefs = loadParticleDefs();
  registry = { commands: [] as any[], enums: new Map<string, string[]>() };
  stats = { spawnCalls: 0, topmost: 0, rays: 0, mapColorReads: 0, isChunkLoaded: 0, worldWrites: 0 };
  opts: Required<Omit<FakeOptions, 'overworld' | 'keepWorldProps'>> = { viewRadius: 6, areaDelay: 3, jobStepsPerTick: 400 };
  system = new FakeSystem();
  world = new FakeWorld();
  private loadedCache = new Map<Dimension, Set<string>>();
  private loadedTick = -1;

  reset(o: FakeOptions = {}): void {
    const props = o.keepWorldProps ? this.world.props : new Map<string, unknown>();
    this.tick = 0;
    this.timeOfDay = 6000;
    this.players = [];
    this.areas.clear();
    this.maxAreas = 0;
    this.areaAdds = 0;
    this.uncaught = [];
    this.logs = [];
    this.registry = { commands: [], enums: new Map() };
    this.stats = { spawnCalls: 0, topmost: 0, rays: 0, mapColorReads: 0, isChunkLoaded: 0, worldWrites: 0 };
    this.opts = { viewRadius: o.viewRadius ?? 6, areaDelay: o.areaDelay ?? 3, jobStepsPerTick: o.jobStepsPerTick ?? 400 };
    this.dimensions = new Map([
      ['overworld', new Dimension('minecraft:overworld', o.overworld ?? defaultColumn)],
      ['nether', new Dimension('minecraft:nether', () => ({ blocks: [{ y: 127, typeId: 'minecraft:bedrock' }], ground: 127 }), 0, 128)],
      ['the_end', new Dimension('minecraft:the_end', (x, z) => (x * x + z * z < 80 * 80 ? { blocks: [{ y: 60, typeId: 'minecraft:end_stone' }], ground: 60 } : undefined), 0, 256)],
    ]);
    // Rebind singletons so stale subscriptions from earlier runs are dropped.
    this.system = new FakeSystem();
    this.world = new FakeWorld();
    this.world.props = props;
    system = this.system;
    world = this.world;
    this.loadedCache.clear();
    this.loadedTick = -1;
  }

  /** Fires startup (custom commands) and worldLoad. */
  boot(): void {
    this.system.beforeEvents.startup.fire({
      customCommandRegistry: {
        registerEnum: (name: string, values: string[]) => this.registry.enums.set(name, values),
        registerCommand: (def: any, cb: any) => this.registry.commands.push({ def, cb }),
      },
    });
    this.world.afterEvents.worldLoad.fire({});
  }

  join(name: string, loc: Vector3, dim = 'overworld', viewRadius = this.opts.viewRadius): Player {
    const p = new Player(`id-${name}`, name, this.dimensions.get(dim)!, loc, viewRadius);
    this.players.push(p);
    this.loadedTick = -1;
    this.world.afterEvents.playerSpawn.fire({ player: p, initialSpawn: true });
    return p;
  }

  leave(p: Player): void {
    p.isValid = false;
    this.loadedTick = -1;
    this.world.afterEvents.playerLeave.fire({ playerId: p.id, playerName: p.name });
  }

  changeDimension(p: Player, dim: string, loc: Vector3): void {
    const from = p.dimension;
    p.dimension = this.dimensions.get(dim)!;
    p.location = loc;
    this.loadedTick = -1;
    this.world.afterEvents.playerDimensionChange.fire({ player: p, fromDimension: from, toDimension: p.dimension, fromLocation: loc, toLocation: loc });
  }

  /** Invokes `/dl:horizon [action] [value]` as the player. */
  command(dim: Dimension, player: Player | undefined, cmd: string): boolean {
    const fog = /^fog @s (push|pop|remove) (\S+)(?: (\S+))?$/.exec(cmd);
    if (fog && player) {
      if (fog[1] === 'push') player.fogStack.push({ fog: fog[2], id: fog[3] });
      else {
        const id = fog[2];
        for (let i = player.fogStack.length - 1; i >= 0; i--) {
          if (player.fogStack[i].id === id) {
            player.fogStack.splice(i, 1);
            if (fog[1] === 'pop') break;
          }
        }
      }
      return true;
    }
    const add = /^tickingarea add (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)$/.exec(cmd);
    if (add) {
      const [x1, , z1, x2, , z2] = add.slice(1, 7).map(Number);
      const chunks = (Math.floor(x2 / 16) - Math.floor(x1 / 16) + 1) * (Math.floor(z2 / 16) - Math.floor(z1 / 16) + 1);
      if (chunks > 100) throw new Error('ticking area too large');
      if (this.areas.size >= 10 || this.areas.has(add[7])) throw new Error('too many ticking areas');
      this.areas.set(add[7], { dim, x1, z1, x2, z2, since: this.tick });
      this.areaAdds++;
      this.maxAreas = Math.max(this.maxAreas, this.areas.size);
      this.loadedTick = -1;
      return true;
    }
    const rm = /^tickingarea remove (\S+)$/.exec(cmd);
    if (rm) {
      const ok = this.areas.delete(rm[1]);
      this.loadedTick = -1;
      if (!ok) throw new Error(`no ticking area ${rm[1]}`);
      return true;
    }
    throw new Error(`unsupported command: ${cmd}`);
  }

  runCustomCommand(p: Player, action?: string, value?: number): void {
    const c = this.registry.commands[0];
    if (!c) throw new Error('command not registered');
    c.cb({ sourceEntity: p, initiator: p, sourceType: 'Entity' }, action, value);
  }

  scriptEvent(p: Player | undefined, id: string, message = ''): void {
    this.system.afterEvents.scriptEventReceive.fire({ id, message, sourceEntity: p, sourceType: p ? 'Entity' : 'Server' });
  }

  serverLoaded(dim: Dimension, cx: number, cz: number): boolean {
    if (this.loadedTick !== this.tick) this.rebuildLoaded();
    return this.loadedCache.get(dim)?.has(`${cx},${cz}`) ?? false;
  }

  private rebuildLoaded(): void {
    this.loadedTick = this.tick;
    this.loadedCache = new Map();
    const add = (d: Dimension, cx: number, cz: number) => {
      let s = this.loadedCache.get(d);
      if (!s) this.loadedCache.set(d, (s = new Set()));
      s.add(`${cx},${cz}`);
    };
    for (const p of this.players) {
      if (!p.isValid) continue;
      const pcx = Math.floor(p.location.x / 16);
      const pcz = Math.floor(p.location.z / 16);
      const r = p.viewRadius;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) add(p.dimension, pcx + dx, pcz + dz);
    }
    for (const a of this.areas.values()) {
      if (this.tick - a.since < this.opts.areaDelay) continue;
      for (let cz = Math.floor(a.z1 / 16); cz <= Math.floor(a.z2 / 16); cz++)
        for (let cx = Math.floor(a.x1 / 16); cx <= Math.floor(a.x2 / 16); cx++) add(a.dim, cx, cz);
    }
  }

  /** Advances one game tick: timers, jobs, client particle lifetimes and self-culling. */
  step(): void {
    this.tick++;
    if (this.world.gameRules.doDayLightCycle) this.timeOfDay = (this.timeOfDay + 1) % 24000;
    clockMs += 50;
    for (const p of this.players) p.spawnedThisTick = 0;
    const due = this.system.timers.filter((t) => t.at <= this.tick);
    for (const t of due) {
      try {
        t.cb();
      } catch (err) {
        this.uncaught.push(err);
      }
      if (t.every > 0) t.at = this.tick + t.every;
      else this.system.timers = this.system.timers.filter((x) => x !== t);
    }
    for (const [id, g] of [...this.system.jobs]) {
      for (let i = 0; i < this.opts.jobStepsPerTick; i++) {
        let r;
        try {
          r = g.next();
        } catch (err) {
          this.uncaught.push(err);
          this.system.jobs.delete(id);
          break;
        }
        if (r.done) {
          this.system.jobs.delete(id);
          break;
        }
      }
    }
    for (const p of this.players) this.cullParticles(p);
  }

  private cullParticles(p: Player): void {
    const keep: ClientParticle[] = [];
    for (const q of p.particles) {
      if (q.dieAt <= this.tick) continue;
      const def = this.particleDefs.get(q.effect)!;
      const cx = Math.floor(q.x / 16);
      const cz = Math.floor(q.z / 16);
      if (p.clientHas(cx, cz)) {
        const b = p.dimension.blockAt(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z));
        if (def.expire.has(b.typeId)) continue;
      }
      keep.push(q);
    }
    p.particles.length = 0;
    p.particles.push(...keep);
  }
}

/** Simulated wall clock: advances 50 ms per tick and a little per read so time budgets terminate. */
let clockMs = 1_000_000;
const realNow = Date.now;
export function installFakeClock(): void {
  Date.now = () => (clockMs += 0.01);
}
export function restoreClock(): void {
  Date.now = realNow;
}

export const fake = new Controller();
export let system: FakeSystem = fake.system;
export let world: FakeWorld = fake.world;
// Classes used only as types by the add-on still need runtime exports for `import { ... }`.
export class Entity {}
export class ItemStack {}
export { SEA_LEVEL };
