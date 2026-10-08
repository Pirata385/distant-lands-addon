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
  /** Bumped whenever the tile is (re)spawned or remeshed; invalidates queued refreshes. */
  seq = 0;
  spawnedAt = -1;

  constructor(public tile: Tile) {}
}

interface RefreshEntry {
  s: TileState;
  seq: number;
  due: number;
  expires: number;
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
  private readonly heap = new MinHeap<RefreshEntry>();
  private current: TileState | null = null;
  private cursor = 0;
  private currentStart = 0;
  private currentGrow = 0;
  private currentLife = 0;
  private currentRefresh = 0;
  private readonly emitter: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly vars: SpawnVars = { ox: 0, oy: 0, oz: 0, a: 0, b: 0, r: 0, g: 0, bl: 0, life: 0, l0: 1, dl: 0, grow: 0 };
  /** Quads across all meshed tiles (what a full refresh cycle must spawn). */
  totalQuads = 0;
  spawnedTotal = 0;
  lastRefreshInterval = 0;

  /** Replaces the wanted tile set. `sigOf` gives each tile's content signature (cell size + data versions). */
  setPlan(tiles: readonly Tile[], sigOf: (t: Tile) => string, p: ViewParams): void {
    const next = new Map<string, TileState>();
    for (const t of tiles) {
      let s = this.states.get(t.key);
      if (!s) s = new TileState(t);
      else s.tile = t;
      s.wantedSig = sigOf(t);
      s.score = score(t, p);
      next.set(t.key, s);
    }
    for (const [k, s] of this.states) {
      if (next.has(k)) continue;
      s.removed = true;
      if (s.quads) this.totalQuads -= s.quads.length / QUAD_STRIDE;
      if (this.current === s) this.current = null;
    }
    this.states = next;
    this.meshQueue = [];
    for (const s of next.values()) if (s.sig !== s.wantedSig) this.meshQueue.push(s);
    this.meshQueue.sort((a, b) => a.score - b.score);
    this.meshPos = 0;
    const pending: TileState[] = [];
    for (let i = this.spawnPos; i < this.spawnQueue.length; i++) {
      const s = this.spawnQueue[i];
      if (!s.removed && s.pendingSpawn) pending.push(s);
    }
    pending.sort((a, b) => a.score - b.score);
    this.spawnQueue = pending;
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
    s.seq++;
    this.totalQuads += quads.length / QUAD_STRIDE;
    if (this.current === s) this.current = null;
    if (quads.length === 0) {
      s.pendingSpawn = false;
      return;
    }
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

  /** Spawns up to `budget` particles. Returns the number spawned. */
  pump(now: number, budget: number, sink: ParticleSink, p: ViewParams): number {
    if (this.paused || budget <= 0) return 0;
    let spawned = 0;
    while (spawned < budget) {
      if (!this.current && !this.pick(now, p)) break;
      const s = this.current!;
      const q = s.quads!;
      const total = q.length / QUAD_STRIDE;
      const v = this.vars;
      const e = this.emitter;
      while (this.cursor < total && spawned < budget) {
        const o = this.cursor * QUAD_STRIDE;
        let wx = s.tile.x0 + q[o + 1];
        const wy = q[o + 2];
        let wz = s.tile.z0 + q[o + 3];
        if (q[o] === K_WALL && !s.tile.conservative) {
          // Camera-facing walls stand at the cell edge nearest this player (half a block inside the cell, so the
          // particle still sits in the column's blocks): a wall in the middle of the cell lets downward rays slip
          // under it right behind the step.
          const dx = p.eye.x - wx;
          const dz = p.eye.z - wz;
          const m = Math.max(Math.abs(dx), Math.abs(dz));
          if (m > 0) {
            const k = Math.max(0, q[o + 4] - 0.5) / m;
            wx += dx * k;
            wz += dz * k;
          }
        }
        v.ox = wx - e.x;
        v.oy = wy - e.y;
        v.oz = wz - e.z;
        v.a = q[o + 4];
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
    if (top && top.expires - URGENT_WINDOW <= now) {
      this.heap.pop();
      s = top.s;
    } else {
      while (this.spawnPos < this.spawnQueue.length) {
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
    const overtake = timeToOvertake(s.tile, p);
    if (overtake + 1 < this.currentLife) {
      this.currentLife = Math.max(MIN_LIFE, overtake + 1);
      this.currentRefresh = Math.max(1, this.currentLife - URGENT_WINDOW - 0.5);
    }
    this.currentGrow = fresh && p.transitions ? GROW_SECONDS : 0;
    this.placeEmitter(s, p);
    return true;
  }

  private placeEmitter(s: TileState, p: ViewParams): void {
    const q = s.quads!;
    const dx = s.tile.x0 + s.tile.size / 2 - p.eye.x;
    const dy = q[2] - p.eye.y;
    const dz = s.tile.z0 + s.tile.size / 2 - p.eye.z;
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
    s.seq++;
    this.heap.push(
      { s, seq: s.seq, due: this.currentStart + this.currentRefresh, expires: this.currentStart + this.currentLife },
      this.currentStart + this.currentRefresh,
    );
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
    for (const s of this.states.values()) s.removed = true;
    this.states = new Map();
    this.meshQueue = [];
    this.meshPos = 0;
    this.spawnQueue = [];
    this.spawnPos = 0;
    this.heap.clear();
    this.current = null;
    this.totalQuads = 0;
  }
}
