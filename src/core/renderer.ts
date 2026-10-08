import { K_WALL, QUAD_STRIDE } from './mesher';
import type { Tile } from './planner';
import type { Vec3 } from './types';
import { MinHeap } from './util/heap';

/** Max distance of the particle emitter from the eye (always inside loaded chunks). */
export const EMIT_DISTANCE = 20;
/** Extra lifetime beyond the refresh interval so refreshed copies overlap and never blink. */
export const LIFE_MARGIN = 5;
/** A refresh this close to expiry pre-empts new tiles. */
export const URGENT_WINDOW = 2.5;
/** Grow-in animation for new or changed tiles. */
export const GROW_SECONDS = 0.35;
/** Head-room factor when estimating how long a full refresh cycle takes. */
const CYCLE_HEADROOM = 1.15;
const SKY_R = 0.67;
const SKY_G = 0.82;
const SKY_B = 1.0;

/** Per-particle Molang inputs. Reused between spawns: sinks must copy what they keep. */
export interface SpawnVars {
  ox: number;
  oy: number;
  oz: number;
  /** Top: half size. Wall: half width. */
  a: number;
  /** Top: half size. Wall: half height. */
  b: number;
  r: number;
  g: number;
  bl: number;
  life: number;
  l0: number;
  dl: number;
  grow: number;
}

export interface ParticleSink {
  /** Spawns one LOD particle visible to this view's player. May throw (e.g. unloaded location). */
  spawn(kind: number, emitter: Vec3, vars: SpawnVars): void;
}

export interface ViewParams {
  eye: Vec3;
  /** View direction (only x/z are used for priorities). */
  dir: Vec3;
  minY: number;
  maxY: number;
  /** Configured refresh interval in seconds. */
  refresh: number;
  transitions: boolean;
  /** Aerial perspective strength 0..1. */
  aerial: number;
  /** Distance (blocks) where LOD ends; aerial perspective is scaled to it. */
  fadeEnd: number;
  l0: number;
  dl: number;
  /** Spawns per second this player can expect on average. */
  share: number;
  /** Player velocity (blocks/s); tiles being approached get lifetimes that end when real terrain arrives. */
  velocity?: Vec3;
  /** Radius (blocks) of the real terrain around the player. */
  innerRadius?: number;
}

/** Shortest lifetime given to a tile the player is approaching. */
export const MIN_LIFE = 3;
/**
 * A tile whose lifetime was shortened because the player is approaching it is not refreshed early: it is looked at
 * again this long before its faces expire (spawned again only if the real terrain has not taken over).
 */
const CAPPED_CHECK = 0.5;
/**
 * Faces of tiles spawned within this many chunks beyond the real-terrain radius may have self-culled against real
 * blocks (the client can keep chunks a little longer than the server); they are sent again once the player has
 * moved away and the tile is outside the real terrain.
 */
const RESPAWN_MARGIN_CHUNKS = 1;

/**
 * Chunk distance from the player's chunk to the tile's nearest chunk: the measure the game uses for loaded chunks
 * (a chunk is loaded when (cx - pcx)² + (cz - pcz)² <= r²).
 */
function chunkDistance(t: Tile, eye: Vec3): number {
  const pcx = Math.floor(eye.x / 16);
  const pcz = Math.floor(eye.z / 16);
  const c0x = Math.floor(t.x0 / 16);
  const c0z = Math.floor(t.z0 / 16);
  const n = t.size / 16 - 1;
  const dx = Math.max(c0x - pcx, 0, pcx - (c0x + n));
  const dz = Math.max(c0z - pcz, 0, pcz - (c0z + n));
  return Math.hypot(dx, dz);
}

/** Seconds until the player, moving at `velocity`, has the tile's nearest point inside the real-terrain radius. */
function timeToOvertake(t: Tile, p: ViewParams): number {
  const v = p.velocity;
  if (!v || p.innerRadius === undefined) return Infinity;
  const nx = Math.max(t.x0, Math.min(p.eye.x, t.x0 + t.size)) - p.eye.x;
  const nz = Math.max(t.z0, Math.min(p.eye.z, t.z0 + t.size)) - p.eye.z;
  const d = Math.hypot(nx, nz);
  const toward = d > 0 ? (v.x * nx + v.z * nz) / d : Math.hypot(v.x, v.z);
  if (toward <= 0.5) return Infinity;
  return Math.max(0, d - p.innerRadius) / toward;
}

export class TileState {
  /** Signature of the mesh in `quads`. */
  sig = '';
  /** Signature the current plan wants. */
  wantedSig = '';
  quads: Float32Array | null = null;
  score = 0;
  removed = false;
  everSpawned = false;
  pendingSpawn = false;
  /** Bumped whenever the tile is (re)spawned, or remeshed to nothing; invalidates queued refreshes. */
  seq = 0;
  spawnedAt = -1;
  /** Smallest chunk distance from the player to the tile since its last spawn (the client may have culled it). */
  minNear = Infinity;
  /** The next spawn re-sends unchanged faces: no grow-in animation. */
  quiet = false;

  constructor(public tile: Tile) {}
}

interface RefreshEntry {
  s: TileState;
  seq: number;
  due: number;
  expires: number;
}

/** Score bucket width (blocks) for priority ordering. */
const SCORE_BUCKET = 16;

/** Orders tiles by score with a bucket sort (stable within a bucket; no comparator calls). */
function byScore(list: TileState[]): TileState[] {
  if (list.length < 2) return list;
  let max = 0;
  for (const s of list) if (s.score > max) max = s.score;
  const n = Math.min(4096, Math.floor(max / SCORE_BUCKET) + 1);
  const buckets: (TileState[] | undefined)[] = new Array(n);
  for (const s of list) {
    const b = Math.min(n - 1, Math.floor(s.score / SCORE_BUCKET));
    const bucket = buckets[b];
    if (bucket) bucket.push(s);
    else buckets[b] = [s];
  }
  const out: TileState[] = [];
  for (const bucket of buckets) if (bucket) for (const s of bucket) out.push(s);
  return out;
}

function score(t: Tile, p: ViewParams): number {
  const cx = t.x0 + t.size / 2 - p.eye.x;
  const cz = t.z0 + t.size / 2 - p.eye.z;
  const d = Math.hypot(cx, cz);
  const dl = Math.hypot(p.dir.x, p.dir.z);
  const cos = d > 0 && dl > 0 ? (cx * p.dir.x + cz * p.dir.z) / (d * dl) : 1;
  return d * (1 + 0.75 * (1 - cos));
}

/**
 * Per-player LOD state: which tiles are wanted, their meshes, and a spawn schedule that keeps every tile's
 * particles alive (rolling refresh) while giving new tiles and tiles about to expire priority.
 */
export class PlayerView {
  states = new Map<string, TileState>();
  paused = false;
  private meshQueue: TileState[] = [];
  private meshPos = 0;
  private spawnQueue: TileState[] = [];
  private spawnPos = 0;
  /** Tiles whose faces self-culled and left a hole: sent before new tiles. */
  private respawnQueue: TileState[] = [];
  private readonly heap = new MinHeap<RefreshEntry>();
  private current: TileState | null = null;
  private cursor = 0;
  private currentStart = 0;
  private currentGrow = 0;
  private currentLife = 0;
  private currentRefresh = 0;
  private currentNear = Infinity;
  private currentCapped = false;
  /** Tiles near the edge of the real terrain, whose faces self-cull while the player passes (rebuilt per plan). */
  private watch: TileState[] = [];
  private lastWatch = -Infinity;
  private readonly emitter: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly vars: SpawnVars = { ox: 0, oy: 0, oz: 0, a: 0, b: 0, r: 0, g: 0, bl: 0, life: 0, l0: 1, dl: 0, grow: 0 };
  /** Quads across all meshed tiles (what a full refresh cycle must spawn). */
  totalQuads = 0;
  spawnedTotal = 0;
  lastRefreshInterval = 0;

  private building: Map<string, TileState> | null = null;
  private buildParams: ViewParams | null = null;
  private buildWatch: TileState[] = [];

  /** Replaces the wanted tile set. `sigOf` gives each tile's content signature (cell size + data versions). */
  setPlan(tiles: readonly Tile[], sigOf: (t: Tile) => string, p: ViewParams): void {
    this.beginPlan(p);
    for (const t of tiles) this.addPlanTile(t, sigOf(t));
    this.commitPlan();
  }

  /** Starts building a new plan; the current plan keeps rendering until commitPlan(). */
  beginPlan(p: ViewParams): void {
    this.building = new Map();
    this.buildParams = p;
    this.buildWatch = [];
  }

  /** Adds a tile to the plan being built. Returns false when no plan is being built (the view was reset). */
  addPlanTile(t: Tile, sig: string): boolean {
    if (!this.building || !this.buildParams) return false;
    let s = this.states.get(t.key) ?? this.building.get(t.key);
    if (!s) s = new TileState(t);
    else s.tile = t;
    s.wantedSig = sig;
    s.score = score(t, this.buildParams);
    this.building.set(t.key, s);
    // Only tiles this close can reach the real-terrain edge before the next plan (plans follow every 8 blocks).
    const inner = this.buildParams.innerRadius;
    if (inner !== undefined && inner > 0 && chunkDistance(t, this.buildParams.eye) <= inner / 16 + RESPAWN_MARGIN_CHUNKS + 2) {
      this.buildWatch.push(s);
    }
    return true;
  }

  abortPlan(): void {
    this.building = null;
    this.buildParams = null;
    this.buildWatch = [];
  }

  /** Swaps in the plan built since beginPlan(). Linear time (no comparator sort: cheap in QuickJS). */
  commitPlan(): void {
    const next = this.building;
    if (!next) return;
    this.building = null;
    this.buildParams = null;
    for (const [k, s] of this.states) {
      if (next.has(k)) continue;
      s.removed = true;
      if (s.quads) this.totalQuads -= s.quads.length / QUAD_STRIDE;
      if (this.current === s) this.current = null;
    }
    this.states = next;
    this.watch = this.buildWatch;
    this.buildWatch = [];
    const mesh: TileState[] = [];
    for (const s of next.values()) if (s.sig !== s.wantedSig) mesh.push(s);
    this.meshQueue = byScore(mesh);
    this.meshPos = 0;
    const pending: TileState[] = [];
    for (let i = this.spawnPos; i < this.spawnQueue.length; i++) {
      const s = this.spawnQueue[i];
      if (!s.removed && s.pendingSpawn) pending.push(s);
    }
    this.spawnQueue = byScore(pending);
    this.spawnPos = 0;
  }

  /** Highest-priority tile that needs a (new) mesh, if any. */
  nextToMesh(): TileState | undefined {
    while (this.meshPos < this.meshQueue.length) {
      const s = this.meshQueue[this.meshPos++];
      if (!s.removed && s.sig !== s.wantedSig) return s;
    }
    return undefined;
  }

  /** Installs a mesh built for signature `sig`; ignored when the tile is gone or wants a newer signature. */
  setMesh(s: TileState, quads: Float32Array, sig: string): void {
    if (s.removed || sig !== s.wantedSig) return;
    if (s.quads) this.totalQuads -= s.quads.length / QUAD_STRIDE;
    s.quads = quads;
    s.sig = sig;
    this.totalQuads += quads.length / QUAD_STRIDE;
    if (quads.length === 0) {
      s.seq++; // nothing left to keep alive: drop the queued refresh
      s.pendingSpawn = false;
      if (this.current === s) this.current = null;
      return;
    }
    if (this.current === s) {
      this.cursor = 0; // being spawned right now: spawn the new mesh from the start
      return;
    }
    // The queued refresh stays valid (it spawns the new mesh if it comes due first), so a busy spawn queue cannot
    // let the tile's current faces expire; the tile is also queued as new content.
    if (!s.pendingSpawn) {
      s.pendingSpawn = true;
      this.spawnQueue.push(s);
    }
  }

  /** Refresh interval actually used: stretched when the spawn budget cannot cycle all quads in time. */
  refreshInterval(p: ViewParams): number {
    const cycle = (this.totalQuads / Math.max(1, p.share)) * CYCLE_HEADROOM;
    this.lastRefreshInterval = Math.max(p.refresh, cycle);
    return this.lastRefreshInterval;
  }

  /**
   * Faces spawned while their chunks were (or might still be) real terrain self-culled against its blocks. Once the
   * player has moved away and those chunks are gone, send them again instead of leaving a hole until the refresh.
   */
  private respawnUncovered(now: number, p: ViewParams): void {
    if (this.watch.length === 0 || p.innerRadius === undefined || now - this.lastWatch < 0.25) return;
    this.lastWatch = now;
    const r = p.innerRadius / 16;
    for (const s of this.watch) {
      if (s.removed) continue;
      const near = chunkDistance(s.tile, p.eye);
      if (near < s.minNear) s.minNear = near;
      if (s.pendingSpawn || this.current === s || !s.quads || s.quads.length === 0) continue;
      // Possibly culled (it was within the real terrain, or just outside it while the client may still have had
      // the chunks), and now outside it and farther away than then: the client has dropped those blocks.
      if (s.minNear <= r + RESPAWN_MARGIN_CHUNKS && near > r && near > s.minNear) {
        s.pendingSpawn = true;
        s.quiet = true;
        this.respawnQueue.push(s);
      }
    }
  }

  /** Spawns up to `budget` particles. Returns the number spawned. */
  pump(now: number, budget: number, sink: ParticleSink, p: ViewParams): number {
    if (this.paused || budget <= 0) return 0;
    this.respawnUncovered(now, p);
    let spawned = 0;
    while (spawned < budget) {
      if (!this.current && !this.pick(now, p)) break;
      const s = this.current!;
      const q = s.quads!;
      // Over real terrain, walls stay centred and as wide as the cell: inside the column's blocks they self-cull,
      // moved or widened they could stand in the air where the real surface dips between samples.
      const free = p.innerRadius === undefined || this.currentNear > p.innerRadius / 16;
      const total = q.length / QUAD_STRIDE;
      const v = this.vars;
      const e = this.emitter;
      while (this.cursor < total && spawned < budget) {
        const o = this.cursor * QUAD_STRIDE;
        let wx = s.tile.x0 + q[o + 1];
        const wy = q[o + 2];
        let wz = s.tile.z0 + q[o + 3];
        let widen = 1;
        if (q[o] === K_WALL && free) {
          const dx = p.eye.x - wx;
          const dz = p.eye.z - wz;
          const m = Math.max(Math.abs(dx), Math.abs(dz));
          if (m > 0) {
            // Camera-facing walls are as wide as the cell looks from here (a square seen at an angle is up to √2
            // wider than its side) and stand at the cell edge nearest this player, half a block inside the cell so
            // the particle still sits in the column's blocks: a wall in the middle of the cell lets downward rays
            // slip under it right behind the step.
            widen = (Math.abs(dx) + Math.abs(dz)) / Math.hypot(dx, dz);
            const k = Math.max(0, q[o + 4] - 0.5) / m;
            wx += dx * k;
            wz += dz * k;
          }
        }
        // Each face gets its own emitter on the eye→face ray, within reach of the player: it is always in a loaded
        // chunk (also right after a teleport), and on screen whenever the face is, should the client cull
        // particles by emitter position.
        this.placeEmitter(wx, wy, wz, p);
        v.ox = wx - e.x;
        v.oy = wy - e.y;
        v.oz = wz - e.z;
        v.a = q[o + 4] * widen;
        v.b = q[o + 5];
        let r = q[o + 6];
        let g = q[o + 7];
        let b = q[o + 8];
        if (p.aerial > 0) {
          const d = Math.hypot(wx - p.eye.x, wz - p.eye.z);
          const t = p.aerial * 0.6 * Math.max(0, Math.min(1, (d - 0.25 * p.fadeEnd) / (0.75 * p.fadeEnd)));
          r += (SKY_R - r) * t;
          g += (SKY_G - g) * t;
          b += (SKY_B - b) * t;
        }
        v.r = r;
        v.g = g;
        v.bl = b;
        v.life = this.currentLife;
        v.l0 = p.l0;
        v.dl = p.dl;
        v.grow = this.currentGrow;
        try {
          sink.spawn(q[o], e, v);
        } catch {
          return spawned;
        }
        this.cursor++;
        spawned++;
        this.spawnedTotal++;
      }
      if (this.cursor >= total) this.finish();
    }
    return spawned;
  }

  private pick(now: number, p: ViewParams): boolean {
    // Drop stale refresh entries.
    while (this.heap.size) {
      const top = this.heap.peek()!;
      if (!top.s.removed && top.s.seq === top.seq) break;
      this.heap.pop();
    }
    const top = this.heap.peek();
    let s: TileState | undefined;
    let fresh = false;
    // Heap keys are the times refreshes become urgent (see finish()).
    if (top && this.heap.peekKey() <= now) {
      this.heap.pop();
      s = top.s;
    } else {
      // Holes first (faces that self-culled against terrain that is gone now), then new tiles, then refreshes.
      while (this.respawnQueue.length > 0) {
        const c = this.respawnQueue.pop()!;
        if (!c.removed && c.pendingSpawn && c.quads) {
          s = c;
          break;
        }
      }
      while (!s && this.spawnPos < this.spawnQueue.length) {
        const c = this.spawnQueue[this.spawnPos++];
        if (!c.removed && c.pendingSpawn && c.quads) {
          s = c;
          fresh = true;
          break;
        }
      }
      if (this.spawnPos >= this.spawnQueue.length) {
        this.spawnQueue = [];
        this.spawnPos = 0;
      }
      if (!s && top && top.due <= now) {
        this.heap.pop();
        s = top.s;
      }
    }
    if (!s || !s.quads) return false;
    s.pendingSpawn = false;
    this.current = s;
    this.cursor = 0;
    this.currentStart = now;
    this.currentRefresh = this.refreshInterval(p);
    this.currentLife = this.currentRefresh + LIFE_MARGIN;
    this.currentCapped = false;
    const overtake = timeToOvertake(s.tile, p);
    if (overtake + 1 < this.currentLife) {
      // The real terrain arrives first: faces end about then (they cannot be removed once spawned).
      this.currentLife = Math.max(MIN_LIFE, overtake + 1);
      this.currentCapped = true;
    }
    this.currentGrow = fresh && p.transitions && !s.quiet ? GROW_SECONDS : 0;
    s.quiet = false;
    this.currentNear = chunkDistance(s.tile, p.eye);
    return true;
  }

  private placeEmitter(x: number, y: number, z: number, p: ViewParams): void {
    const dx = x - p.eye.x;
    const dy = y - p.eye.y;
    const dz = z - p.eye.z;
    const len = Math.hypot(dx, dy, dz);
    const k = len > 0 ? Math.min(EMIT_DISTANCE, len * 0.5) / len : 0;
    this.emitter.x = p.eye.x + dx * k;
    this.emitter.y = Math.max(p.minY + 1, Math.min(p.maxY - 1, p.eye.y + dy * k));
    this.emitter.z = p.eye.z + dz * k;
  }

  private finish(): void {
    const s = this.current!;
    s.everSpawned = true;
    s.spawnedAt = this.currentStart;
    s.minNear = this.currentNear;
    s.seq++;
    // Keyed by when the refresh becomes urgent, so a tile with a shortened lifetime is never hidden behind one
    // that is due earlier but expires later. Shortened tiles are only looked at again just before they expire.
    const expires = this.currentStart + this.currentLife;
    if (this.currentCapped) {
      this.heap.push({ s, seq: s.seq, due: expires - CAPPED_CHECK, expires }, expires - CAPPED_CHECK);
    } else {
      this.heap.push({ s, seq: s.seq, due: this.currentStart + this.currentRefresh, expires }, expires - URGENT_WINDOW);
    }
    this.current = null;
  }

  stats(): { tiles: number; meshed: number; pendingMesh: number; pendingSpawn: number; quads: number; refresh: number } {
    let meshed = 0;
    for (const s of this.states.values()) if (s.quads) meshed++;
    return {
      tiles: this.states.size,
      meshed,
      pendingMesh: this.meshQueue.length - this.meshPos,
      pendingSpawn: this.spawnQueue.length - this.spawnPos,
      quads: this.totalQuads,
      refresh: this.lastRefreshInterval,
    };
  }

  /** Forget everything (dimension change, disable). Already spawned particles expire on their own. */
  reset(): void {
    this.abortPlan();
    for (const s of this.states.values()) s.removed = true;
    this.states = new Map();
    this.meshQueue = [];
    this.meshPos = 0;
    this.spawnQueue = [];
    this.spawnPos = 0;
    this.heap.clear();
    this.watch = [];
    this.respawnQueue = [];
    this.current = null;
    this.totalQuads = 0;
  }
}
