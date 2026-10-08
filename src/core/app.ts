import { Capture } from './capture';
import { StoreLookup } from './cells';
import { FogManager, fogIdFor } from './fog';
import { LodGenerator } from './generator';
import { formatHud } from './hud';
import { lightParams } from './lighting';
import { K_TOP, meshTile, StyleParams } from './mesher';
import { planTiles, Tile } from './planner';
import { detectRadius } from './radius';
import { ParticleSink, PlayerView, ViewParams } from './renderer';
import { SamplerOptions } from './sampler';
import { MAX_LOD_CHUNKS, RES_OPTIONS, Settings, Effective } from './settings';
import { LodStore } from './store';
import { NO_DATA } from './flags';
import { EFFECT_TOP, EFFECT_WALL, Host, HostDimension, HostPlayer, Vec3 } from './types';
import { Scheduler } from './scheduler';
import { Lru } from './util/lru';
import { PlayerFocus, WorkRegistry } from './work';

export const SETTINGS_KEY = 'dl:settings';
export const PLAYER_KEY = 'dl:player';

/** LOD starts this many chunks inside the detected vanilla radius; overlapping quads self-cull. */
const INNER_OVERLAP = 1;
/** Chunks beyond the LOD inner edge drawn with conservative heights (stay under the real surface). */
const CONSERVATIVE_BAND = 2;
/** Faster than this (blocks/s) between updates is treated as a teleport, not movement. */
const TELEPORT_SPEED = 120;
const PLAN_MOVE_BLOCKS = 8;
const PLAN_INTERVAL = 40;
const RADIUS_INTERVAL = 60;
const UPDATE_INTERVAL = 5;
const ADAPT_INTERVAL = 100;
const HUD_INTERVAL = 10;
const ACQUIRE_INTERVAL = 20;
const FLUSH_INTERVAL = 10;
const EVICT_INTERVAL = 1200;
const SYNC_INTERVAL = 20;
const MESH_CACHE_TILES = 8000;
/** The mesh cache keeps this many meshes beyond the tiles currently planned for all players (for re-use). */
const MESH_CACHE_SLACK = 512;
/** Server considered lagging when the average tick interval exceeds this (ms). */
const LAG_TICK_MS = 65;
/** Pregeneration requests expire after 10 minutes. */
const PREGEN_TICKS = 12000;

interface PlayerState {
  id: string;
  p: HostPlayer;
  view: PlayerView;
  sink: ParticleSink;
  dim: HostDimension | undefined;
  dimIndex: number;
  enabled: boolean;
  eff: Effective;
  pos: Vec3;
  eye: Vec3;
  dir: Vec3;
  flying: boolean;
  /** Smoothed horizontal velocity (blocks/s). */
  vel: Vec3;
  velTick: number;
  loadedRadius: number;
  radiusTick: number;
  needsPlan: boolean;
  planning: boolean;
  planTick: number;
  planX: number;
  planZ: number;
  planEpoch: number;
  planSettings: number;
  planRadius: number;
  prevCells: Map<string, number>;
  qMult: number;
  adaptTick: number;
  spawnCount: number;
  spawnRate: number;
  wasEnabled: boolean;
}

interface Pregen {
  dim: HostDimension;
  x: number;
  z: number;
  radius: number;
  loadedRadius: number;
  until: number;
}

/** Wires settings, data acquisition, planning, meshing and rendering together. Engine-agnostic. */
export class App {
  readonly settings: Settings;
  readonly store: LodStore;
  readonly registry = new WorkRegistry();
  readonly capture: Capture;
  readonly generator: LodGenerator;
  readonly scheduler: Scheduler;
  private readonly fog = new FogManager();
  private readonly states = new Map<string, PlayerState>();
  private readonly meshCache = new Lru<string, Float32Array>(MESH_CACHE_TILES);
  private readonly lookups = new Map<number, StoreLookup>();
  private readonly weather = new Map<number, { rain: number; thunder: number }>();
  private pregens: Pregen[] = [];
  private tickNo = 0;
  private appliedVersion = -1;
  private styleKey = '';
  private styleEpoch = 0;
  private samplerKey = '';
  private style: StyleParams = { style: 0, relief: 0.6, waterDepth: true };
  private sampler: SamplerOptions = { waterDepth: true, vegetation: 0 };
  private res = 4;
  private light = { l0: 1, dl: 0 };
  private spawnRR = 0;
  private meshRR = 0;
  private lastTickMs: number | undefined;
  private tickIntervalEma = 50;
  private tickCostEma = 0;
  private lastTickCost = 0;
  private errors = 0;
  private started = false;

  constructor(private readonly host: Host) {
    this.settings = new Settings({
      loadWorld: () => host.kv.get(SETTINGS_KEY),
      saveWorld: (json) => host.kv.set(SETTINGS_KEY, json),
      loadPlayer: (id) => this.hostPlayer(id)?.loadData(PLAYER_KEY),
      savePlayer: (id, json) => this.hostPlayer(id)?.saveData(PLAYER_KEY, json),
    });
    this.store = new LodStore(host.kv, { res: 4, memoryChunks: 8192, persist: true });
    this.capture = new Capture(this.store, this.registry);
    this.generator = new LodGenerator(this.store, this.registry, (key) => this.notifyOperators(key));
    this.scheduler = new Scheduler(() => host.clock());
    this.scheduler.add('plan', { next: () => this.nextPlan() }, 2);
    this.scheduler.add('mesh', { next: () => this.nextMesh() }, 4);
    this.scheduler.add('capture', { next: () => this.nextCapture() }, 2);
    this.scheduler.add('generate', { next: () => this.nextGeneration() }, 1);
  }

  get playerCount(): number {
    return this.states.size;
  }

  start(): void {
    this.settings.load();
    this.applySettings();
    for (const index of [0, 2]) {
      const dim = this.host.dimension(index);
      if (dim) this.safe(() => this.generator.cleanup(dim));
    }
    this.syncPlayers();
    this.started = true;
  }

  /** Persists pending data and releases ticking areas. */
  shutdown(): void {
    this.generator.cancelAll();
    this.store.flush(Infinity);
  }

  // ------------------------------------------------------------------------------------------- events

  onPlayerJoin(p: HostPlayer): void {
    this.ensure(p);
  }

  onPlayerLeave(id: string): void {
    const s = this.states.get(id);
    if (s) s.view.reset();
    this.states.delete(id);
    this.fog.forget(id);
    this.settings.dropPlayer(id);
  }

  /** A player changed dimension; state is reset on the next update. */
  onDimensionChange(p: HostPlayer): void {
    const s = this.states.get(p.id);
    if (s) s.dimIndex = -1;
  }

  onBlockChanged(dimIndex: number, x: number, z: number): void {
    if (this.settings.flag('trackBlockChanges')) this.store.markDirty(dimIndex, Math.floor(x / 16), Math.floor(z / 16));
  }

  onWeather(dimIndex: number, kind: 'Clear' | 'Rain' | 'Thunder'): void {
    this.weather.set(dimIndex, { rain: kind === 'Clear' ? 0 : 1, thunder: kind === 'Thunder' ? 1 : 0 });
  }

  // ------------------------------------------------------------------------------------------- tick

  /** Per-tick housekeeping and particle spawning. Call every game tick. */
  tick(): void {
    const t0 = this.host.clock();
    if (this.lastTickMs !== undefined) this.tickIntervalEma = this.tickIntervalEma * 0.9 + (t0 - this.lastTickMs) * 0.1;
    this.lastTickMs = t0;
    this.tickNo = this.host.currentTick();
    if (!this.started) this.start();
    if (this.settings.version !== this.appliedVersion) this.applySettings();
    if (this.tickNo % SYNC_INTERVAL === 0) this.syncPlayers();

    const w = this.weather.get(0) ?? { rain: 0, thunder: 0 };
    this.light = lightParams({
      timeOfDay: this.host.timeOfDay(),
      rain: w.rain,
      thunder: w.thunder,
      dayCycle: this.host.dayCycle(),
      enabled: this.settings.flag('dayNight'),
    });

    let i = 0;
    for (const s of [...this.states.values()]) {
      if ((this.tickNo + i++) % UPDATE_INTERVAL === 0) this.safe(() => this.updatePlayer(s), 'update');
    }
    this.safe(() => this.spawnAll(), 'spawn');
    if (this.tickNo % ACQUIRE_INTERVAL === 0) this.safe(() => this.acquire(), 'acquire');
    if (this.tickNo % FLUSH_INTERVAL === 0) this.safe(() => this.store.flush(1), 'flush');
    if (this.tickNo % EVICT_INTERVAL === 0) this.safe(() => this.evict(), 'evict');
    if (this.tickNo % HUD_INTERVAL === 0) this.safe(() => this.hud(), 'hud');
    this.lastTickCost = this.host.clock() - t0;
  }

  /** Background work for this tick (planning, meshing, sampling, generation), bounded by the script budget. */
  *backgroundSlice(): Generator<void, void, void> {
    const budget = Math.max(0.5, this.settings.num('budgetMs') - this.lastTickCost);
    const t0 = this.host.clock();
    try {
      yield* this.scheduler.slice(budget);
    } catch (e) {
      this.error('background', e);
      this.scheduler.abortAll();
    }
    this.tickCostEma = this.tickCostEma * 0.95 + (this.lastTickCost + this.host.clock() - t0) * 0.05;
  }

  get lagging(): boolean {
    return this.tickIntervalEma > LAG_TICK_MS;
  }

  // ------------------------------------------------------------------------------------------- settings

  private applySettings(): void {
    const s = this.settings;
    this.res = Number(RES_OPTIONS[s.num('sampleRes')]);
    this.store.configure({ res: this.res, memoryChunks: s.num('memoryChunks'), persist: s.flag('persist') });
    this.style = { style: s.num('style'), relief: s.num('relief') / 100, waterDepth: s.flag('waterDepth') };
    const styleKey = `${this.style.style}|${this.style.relief}|${this.style.waterDepth}`;
    if (styleKey !== this.styleKey) {
      this.styleKey = styleKey;
      this.styleEpoch++;
      this.meshCache.clear();
    }
    this.sampler = { waterDepth: s.flag('waterDepth'), vegetation: s.num('vegetation') };
    const samplerKey = `${this.sampler.vegetation}|${this.sampler.waterDepth}`;
    if (this.samplerKey && samplerKey !== this.samplerKey) this.store.invalidateBefore(this.tickNo);
    this.samplerKey = samplerKey;
    if (s.num('genMode') !== 2 || !s.flag('enabled')) this.generator.cancelAll();
    for (const st of this.states.values()) st.needsPlan = true;
    this.appliedVersion = s.version;
  }

  // ------------------------------------------------------------------------------------------- players

  private hostPlayer(id: string): HostPlayer | undefined {
    const s = this.states.get(id);
    if (s) return s.p;
    for (const p of this.host.players()) if (p.id === id) return p;
    return undefined;
  }

  private syncPlayers(): void {
    const seen = new Set<string>();
    for (const p of this.host.players()) {
      seen.add(p.id);
      this.ensure(p);
    }
    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.onPlayerLeave(id);
  }

  private ensure(p: HostPlayer): PlayerState {
    let s = this.states.get(p.id);
    if (s) {
      s.p = p;
      return s;
    }
    this.applyDeviceDefaults(p);
    s = {
      id: p.id,
      p,
      view: new PlayerView(),
      sink: {
        spawn: (kind, at, vars) => p.spawnParticle(kind === K_TOP ? EFFECT_TOP : EFFECT_WALL, at, vars),
      },
      dim: undefined,
      dimIndex: -1,
      enabled: false,
      eff: this.settings.effective(p.id),
      pos: { x: 0, y: 0, z: 0 },
      eye: { x: 0, y: 0, z: 0 },
      dir: { x: 0, y: 0, z: 1 },
      flying: false,
      vel: { x: 0, y: 0, z: 0 },
      velTick: -1,
      loadedRadius: 0,
      radiusTick: -Infinity,
      needsPlan: true,
      planning: false,
      planTick: -Infinity,
      planX: 0,
      planZ: 0,
      planEpoch: -1,
      planSettings: -1,
      planRadius: -1,
      prevCells: new Map(),
      qMult: 1,
      adaptTick: this.tickNo,
      spawnCount: 0,
      spawnRate: 0,
      wasEnabled: false,
    };
    this.states.set(p.id, s);
    this.safe(() => this.updatePlayer(s!));
    return s;
  }

  /** Lower defaults for low-memory devices, only when the player has never saved settings. */
  private applyDeviceDefaults(p: HostPlayer): void {
    if (p.loadData(PLAYER_KEY) !== undefined) return;
    const tier = p.memoryTier();
    if (tier !== undefined && tier <= 1) {
      this.settings.setPlayer(p.id, 'pQuads', tier === 0 ? 1500 : 2500);
      this.settings.setPlayer(p.id, 'pQuality', 1);
    }
  }

  private lodDimension(index: number): boolean {
    return index === 0 || (index === 2 && this.settings.flag('renderEnd'));
  }

  private updatePlayer(s: PlayerState): void {
    if (!s.p.isValid()) {
      this.onPlayerLeave(s.id);
      return;
    }
    const dim = s.p.dimension();
    if (dim.index !== s.dimIndex) {
      s.view.reset();
      s.prevCells.clear();
      s.dim = dim;
      s.dimIndex = dim.index;
      s.loadedRadius = 0;
      s.radiusTick = -Infinity;
      s.velTick = -1;
      s.vel = { x: 0, y: 0, z: 0 };
      s.needsPlan = true;
    }
    s.eff = this.settings.effective(s.id);
    s.enabled = s.eff.enabled && this.lodDimension(dim.index);
    this.fog.apply(s.p, s.enabled ? fogIdFor(dim.index, s.eff.distance, this.settings.num('fogMode')) : undefined);
    if (!s.enabled) {
      if (s.wasEnabled) s.view.reset();
      s.wasEnabled = false;
      return;
    }
    if (!s.wasEnabled) s.needsPlan = true;
    s.wasEnabled = true;
    const pos = s.p.location();
    if (s.velTick >= 0 && this.tickNo > s.velTick) {
      const dt = (this.tickNo - s.velTick) / 20;
      let vx = (pos.x - s.pos.x) / dt;
      let vz = (pos.z - s.pos.z) / dt;
      if (Math.hypot(vx, vz) > TELEPORT_SPEED) vx = vz = 0;
      s.vel = { x: s.vel.x * 0.4 + vx * 0.6, y: 0, z: s.vel.z * 0.4 + vz * 0.6 };
    }
    s.velTick = this.tickNo;
    s.pos = pos;
    s.eye = s.p.eye();
    s.dir = s.p.viewDirection();
    s.flying = s.p.isFlying();

    if (this.tickNo - s.radiusTick >= RADIUS_INTERVAL) {
      s.radiusTick = this.tickNo;
      s.loadedRadius = detectRadius(dim, s.pos.x, s.pos.z, MAX_LOD_CHUNKS + 4);
    }

    s.view.paused = this.settings.flag('pauseUnderground') && this.underground(s, dim);

    if (this.settings.flag('adaptive') && this.tickNo - s.adaptTick >= ADAPT_INTERVAL) {
      s.adaptTick = this.tickNo;
      const quads = s.view.totalQuads;
      if (quads > s.eff.maxQuads * 1.05 && s.qMult > 0.3) {
        s.qMult = Math.max(0.3, s.qMult * 0.88);
        s.needsPlan = true;
      } else if (quads < s.eff.maxQuads * 0.7 && s.qMult < 1 && s.view.stats().pendingMesh === 0) {
        s.qMult = Math.min(1, s.qMult * 1.06);
        s.needsPlan = true;
      }
    } else if (!this.settings.flag('adaptive')) {
      s.qMult = 1;
    }

    if (!s.planning) {
      const moved = Math.hypot(s.pos.x - s.planX, s.pos.z - s.planZ) >= PLAN_MOVE_BLOCKS;
      const stale =
        this.tickNo - s.planTick >= PLAN_INTERVAL &&
        (this.store.dataEpoch !== s.planEpoch ||
          this.settings.version !== s.planSettings ||
          s.loadedRadius !== s.planRadius);
      if (moved || stale) s.needsPlan = true;
    }
  }

  private underground(s: PlayerState, dim: HostDimension): boolean {
    let sky = 15;
    try {
      sky = dim.skyLight(Math.floor(s.eye.x), Math.floor(s.eye.y), Math.floor(s.eye.z));
    } catch {
      return false;
    }
    if (sky > 0) return false;
    const lod = this.store.get(dim.index, Math.floor(s.pos.x / 16), Math.floor(s.pos.z / 16));
    if (!lod) return false;
    const top = lod.levels[lod.levels.length - 1].height[0];
    return top !== NO_DATA && s.eye.y < top - 16;
  }

  // ------------------------------------------------------------------------------------------- rendering

  private viewParams(s: PlayerState, share: number): ViewParams {
    return {
      eye: s.eye,
      dir: s.dir,
      minY: s.dim?.minY ?? -64,
      maxY: s.dim?.maxY ?? 320,
      refresh: this.settings.num('refreshSeconds'),
      transitions: this.settings.flag('transitions'),
      aerial: this.settings.num('aerial') / 100,
      fadeEnd: s.eff.distance * 16,
      l0: this.light.l0,
      dl: this.light.dl,
      share,
      velocity: s.vel,
      innerRadius: s.loadedRadius * 16,
    };
  }

  private spawnAll(): void {
    const budget = this.settings.num('spawnsPerTick');
    const active: PlayerState[] = [];
    for (const s of this.states.values()) if (s.enabled && !s.view.paused) active.push(s);
    const n = active.length;
    if (n === 0) return;
    const share = (budget * 20) / n;
    const now = this.tickNo / 20;
    let left = budget;
    const fair = Math.ceil(budget / n);
    for (let pass = 0; pass < 2 && left > 0; pass++) {
      for (let k = 0; k < n && left > 0; k++) {
        const s = active[(this.spawnRR + k) % n];
        const quota = pass === 0 ? Math.min(fair, left) : left;
        const done = s.view.pump(now, quota, s.sink, this.viewParams(s, share));
        s.spawnCount += done;
        left -= done;
      }
    }
    this.spawnRR = (this.spawnRR + 1) % n;
  }

  /** Content signature of a tile: cell size, display style and versions of its chunks and edge neighbours. */
  private signature(dim: number, t: Tile): string {
    const store = this.store;
    let h = (t.cell * 7919 + this.styleEpoch) | 0;
    const c0x = Math.floor(t.x0 / 16);
    const c0z = Math.floor(t.z0 / 16);
    const span = t.size / 16;
    for (let cz = c0z; cz < c0z + span; cz++) {
      for (let cx = c0x; cx < c0x + span; cx++) h = (Math.imul(h, 31) + store.version(dim, cx, cz)) | 0;
    }
    for (let k = 0; k < span; k++) {
      h = (Math.imul(h, 31) + store.version(dim, c0x + k, c0z - 1)) | 0;
      h = (Math.imul(h, 31) + store.version(dim, c0x + k, c0z + span)) | 0;
      h = (Math.imul(h, 31) + store.version(dim, c0x - 1, c0z + k)) | 0;
      h = (Math.imul(h, 31) + store.version(dim, c0x + span, c0z + k)) | 0;
    }
    return `${t.cell}${t.conservative ? 'c' : ''}:${h}`;
  }

  private nextPlan(): Generator<void, boolean, void> | undefined {
    for (const s of this.states.values()) {
      if (s.needsPlan && !s.planning && s.enabled && s.loadedRadius > 0) return this.plan(s);
    }
    return undefined;
  }

  private *plan(s: PlayerState): Generator<void, boolean, void> {
    s.needsPlan = false;
    s.planning = true;
    try {
      const dimIndex = s.dimIndex;
      const epoch = this.store.dataEpoch;
      const version = this.settings.version;
      const radius = s.loadedRadius;
      const px = s.pos.x;
      const pz = s.pos.z;
      const tiles = yield* planTiles({
        px,
        pz,
        rinChunks: Math.max(0, radius - INNER_OVERLAP),
        routChunks: s.eff.distance,
        res: this.res,
        quality: s.eff.quality * s.qMult,
        prev: s.prevCells,
        conservativeChunks: CONSERVATIVE_BAND,
      });
      if (this.states.get(s.id) !== s || s.dimIndex !== dimIndex || !s.enabled) return false;
      // Build the new plan incrementally (the old one keeps rendering), then swap it in.
      const prev = new Map<string, number>();
      s.view.beginPlan(this.viewParams(s, 1));
      let k = 0;
      for (const t of tiles) {
        s.view.addPlanTile(t, this.signature(dimIndex, t));
        prev.set(t.key, t.cell);
        if ((++k & 63) === 0) {
          yield;
          if (this.states.get(s.id) !== s || s.dimIndex !== dimIndex || !s.enabled) {
            s.view.abortPlan();
            return false;
          }
        }
      }
      s.view.commitPlan();
      this.sizeMeshCache();
      s.prevCells = prev;
      s.planTick = this.tickNo;
      s.planX = px;
      s.planZ = pz;
      s.planEpoch = epoch;
      s.planSettings = version;
      s.planRadius = radius;
      return true;
    } finally {
      s.planning = false;
    }
  }

  private lookup(dim: number): StoreLookup {
    let l = this.lookups.get(dim);
    if (!l) {
      l = new StoreLookup(this.store, dim);
      this.lookups.set(dim, l);
    }
    return l;
  }

  /** Sizes the shared mesh cache to the planned tiles plus some slack: unused meshes are heap the GC has to walk. */
  private sizeMeshCache(): void {
    let live = 0;
    for (const st of this.states.values()) live += st.view.states.size;
    this.meshCache.setCapacity(Math.min(MESH_CACHE_TILES, Math.ceil(live * 1.25) + MESH_CACHE_SLACK));
  }

  private nextMesh(): Generator<void, boolean, void> | undefined {
    const list = [...this.states.values()];
    const n = list.length;
    for (let k = 0; k < n; k++) {
      const s = list[(this.meshRR + k) % n];
      if (!s.enabled) continue;
      const t = s.view.nextToMesh();
      if (!t) continue;
      this.meshRR = (this.meshRR + k + 1) % n;
      const dim = s.dimIndex;
      const style = this.style;
      const epoch = this.styleEpoch;
      return (function* (app: App): Generator<void, boolean, void> {
        const key = `${dim}|${t.tile.key}|${t.wantedSig}|${epoch}`;
        let quads = app.meshCache.get(key);
        if (!quads) {
          quads = meshTile(t.tile, app.lookup(dim), style);
          app.meshCache.set(key, quads);
        }
        s.view.setMesh(t, quads, t.wantedSig);
        return true;
      })(this);
    }
    return undefined;
  }

  // ------------------------------------------------------------------------------------------- acquisition

  private focuses(): PlayerFocus[] {
    const out: PlayerFocus[] = [];
    for (const s of this.states.values()) {
      if (!s.enabled || !s.dim) continue;
      out.push({
        id: s.id,
        dim: s.dim,
        x: s.pos.x,
        z: s.pos.z,
        dirX: s.dir.x,
        dirZ: s.dir.z,
        loadedRadius: s.loadedRadius,
        lodRadius: s.eff.distance,
        flying: s.flying,
      });
    }
    this.pregens = this.pregens.filter((g) => g.until > this.tickNo);
    this.pregens.forEach((g, i) =>
      out.push({
        id: `pregen${i}`,
        dim: g.dim,
        x: g.x,
        z: g.z,
        dirX: 0,
        dirZ: 1,
        loadedRadius: g.loadedRadius,
        lodRadius: g.radius,
        flying: false,
      }),
    );
    return out;
  }

  private acquire(): void {
    const s = this.settings;
    const mode = s.flag('enabled') ? s.num('genMode') : 0;
    const focuses = this.focuses();
    if (mode >= 1) this.capture.update(focuses, this.tickNo, s.num('resampleMinutes') * 1200);
    const paused =
      mode !== 2 || this.lagging || (s.flag('genPauseFlying') && focuses.some((f) => f.flying));
    this.generator.update(focuses, this.tickNo, {
      batch: s.num('genBatch'),
      concurrency: s.num('genConcurrency'),
      priority: s.num('genPriority'),
      res: this.res,
      sampler: this.sampler,
      paused,
    });
  }

  private nextCapture(): Generator<void, boolean, void> | undefined {
    if (this.capture.pending === 0) return undefined;
    return this.capture.work(this.tickNo, this.res, this.sampler);
  }

  private nextGeneration(): Generator<void, boolean, void> | undefined {
    if (this.generator.activeCount === 0) return undefined;
    return this.generator.work(this.tickNo);
  }

  private evict(): void {
    const points = [...this.states.values()]
      .filter((s) => s.dim)
      .map((s) => ({ dim: s.dimIndex, cx: Math.floor(s.pos.x / 16), cz: Math.floor(s.pos.z / 16) }));
    this.store.evictStorage(points, this.settings.num('storageMB') * 1024 * 1024);
  }

  // ------------------------------------------------------------------------------------------- HUD & tools

  private hud(): void {
    for (const s of this.states.values()) {
      s.spawnRate = Math.round((s.spawnCount * 20) / HUD_INTERVAL);
      s.spawnCount = 0;
      if (!s.eff.hud) continue;
      s.p.actionBar(formatHud(this.statsFor(s)));
    }
  }

  private statsFor(s: PlayerState) {
    const v = s.view.stats();
    return {
      quads: v.quads,
      tiles: v.tiles,
      spawnRate: s.spawnRate,
      cached: this.store.stats().chunksInMemory,
      genQueue: this.capture.pending + this.generator.activeCount,
      ms: this.tickCostEma,
      radius: s.loadedRadius,
      distance: s.eff.distance,
      refresh: v.refresh || this.settings.num('refreshSeconds'),
      paused: s.view.paused,
    };
  }

  /** Stats for the UI. */
  stats(id: string): ReturnType<App['statsFor']> & { generated: number; sampled: number; storage: number; errors: number; quality: number } | undefined {
    const s = this.states.get(id);
    if (!s) return undefined;
    return {
      ...this.statsFor(s),
      generated: this.generator.generated,
      sampled: this.capture.sampled,
      storage: this.store.stats().bytes,
      errors: this.errors,
      quality: Math.round(s.eff.quality * s.qMult * 10) / 10,
    };
  }

  /** Deletes all LOD data; already spawned particles fade out on their own. */
  clearCache(): void {
    this.generator.cancelAll();
    this.scheduler.abortAll();
    this.store.clear();
    this.meshCache.clear();
    for (const s of this.states.values()) {
      s.view.reset();
      s.needsPlan = true;
    }
  }

  /** Generates LOD data in a radius around the player for the next 10 minutes. */
  pregen(id: string, radius: number): boolean {
    const s = this.states.get(id);
    if (!s || !s.dim || !this.lodDimension(s.dimIndex)) return false;
    this.pregens.push({
      dim: s.dim,
      x: s.pos.x,
      z: s.pos.z,
      radius: Math.min(MAX_LOD_CHUNKS, Math.max(1, radius)),
      loadedRadius: s.loadedRadius,
      until: this.tickNo + PREGEN_TICKS,
    });
    return true;
  }

  toggle(id: string): boolean {
    const now = !(this.settings.playerValue(id, 'pEnabled') as boolean);
    this.settings.setPlayer(id, 'pEnabled', now);
    return now;
  }

  /**
   * Spawns a calibration pattern 32 blocks ahead of the player (a 4×4 colour grid of tops with walls) and returns a
   * capability report.
   */
  selfTest(id: string, capabilities: Record<string, string | number | boolean>): string[] {
    const s = this.states.get(id) ?? this.ensure(this.hostPlayer(id)!);
    const p = s.p;
    const eye = p.eye();
    const dir = p.viewDirection();
    const len = Math.hypot(dir.x, dir.z) || 1;
    const cx = eye.x + (dir.x / len) * 32;
    const cz = eye.z + (dir.z / len) * 32;
    const base = Math.floor(eye.y) - 2;
    const emitter = { x: eye.x + (dir.x / len) * 2, y: eye.y, z: eye.z + (dir.z / len) * 2 };
    let ok = 0;
    let failed = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const h = base + ((i + j) % 3);
        const qx = cx + (i - 1.5) * 4;
        const qz = cz + (j - 1.5) * 4;
        const vars = {
          ox: qx - emitter.x,
          oy: h - emitter.y,
          oz: qz - emitter.z,
          a: 2,
          b: 2,
          r: i / 3,
          g: j / 3,
          bl: 1 - i / 3,
          life: 15,
          l0: 1,
          dl: 0,
          grow: 0.35,
        };
        try {
          p.spawnParticle(EFFECT_TOP, emitter, vars);
          p.spawnParticle(EFFECT_WALL, emitter, { ...vars, oy: h - 1.5 - emitter.y, b: 1.5, r: vars.r * 0.7, g: vars.g * 0.7, bl: vars.bl * 0.7 });
          ok += 2;
        } catch {
          failed += 2;
        }
      }
    }
    const st = this.stats(id);
    const lines = [`particles spawned ${ok}, failed ${failed}`];
    for (const [k, v] of Object.entries(capabilities)) lines.push(`${k}: ${v}`);
    if (st) lines.push(`radius ${st.radius} → ${st.distance}, quads ${st.quads}, cached ${st.cached}, errors ${st.errors}`);
    return lines;
  }

  private notifyOperators(key: string): void {
    for (const s of this.states.values()) if (s.p.isOperator()) s.p.tell(key);
  }

  // ------------------------------------------------------------------------------------------- errors

  /** Longest time (ms) spent per tick section and background job — shown in diagnostics. */
  readonly profile = new Map<string, number>();

  private safe(fn: () => void, section = 'tick'): void {
    const t0 = this.host.clock();
    try {
      fn();
    } catch (e) {
      this.error(section, e);
    }
    const ms = this.host.clock() - t0;
    if (ms > (this.profile.get(section) ?? 0)) this.profile.set(section, ms);
  }

  private error(where: string, e: unknown): void {
    this.errors++;
    if (this.errors <= 20 || this.errors % 500 === 0) {
      this.host.log(`[Distant Lands] ${where} error #${this.errors}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
}
