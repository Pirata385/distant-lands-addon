import { sampleChunk, SamplerOptions } from './sampler';
import { MAX_LOD_CHUNKS } from './settings';
import type { LodStore } from './store';
import type { HostDimension } from './types';
import { PlayerFocus, WorkRegistry } from './work';

/** Give up on a batch whose chunks have not loaded after this many ticks. */
export const GEN_TIMEOUT_TICKS = 600;
/** Pause after the world refused a ticking area (limit of 10 reached). */
export const GEN_BACKOFF_TICKS = 6000;
/** Retry delay for chunks of a timed-out batch. */
const FAILED_CHUNK_TICKS = 2400;
/** The world allows 10 ticking areas; we never use more than 3 and clean up all 10 names at startup. */
const MAX_AREAS = 10;

export const PRIORITY_NEAREST = 0;
export const PRIORITY_VIEW = 1;
export const PRIORITY_BALANCED = 2;

export function areaName(slot: number): string {
  return `dl_gen_${slot}`;
}

export interface GenOptions {
  /** Batch side in chunks (G×G chunks are sampled; the ticking area adds a 1-chunk margin). */
  batch: number;
  concurrency: number;
  priority: number;
  res: number;
  sampler: SamplerOptions;
  /** Do not start new batches (flying, lag, disabled). */
  paused: boolean;
}

interface Batch {
  slot: number;
  dim: HostDimension;
  bx0: number;
  bz0: number;
  size: number;
  startedAt: number;
  /** Tick of the last load check (waiting batches are checked once per tick). */
  checkedAt: number;
  loaded: boolean;
  done: boolean;
  cancelled: boolean;
}

/**
 * Active generation: loads small batches of never-visited chunks with short-lived ticking areas so the real world
 * generator produces them (seed and rules preserved), samples them, and releases the area.
 */
export class LodGenerator {
  private readonly active: Batch[] = [];
  private backoffUntil = -Infinity;
  private notified = false;
  private opts: GenOptions | undefined;
  /** Ring to start searching from, per player (skips rings already complete). */
  private readonly frontier = new Map<string, { cx: number; cz: number; ring: number }>();
  generated = 0;
  failures = 0;

  constructor(
    private readonly store: LodStore,
    private readonly registry: WorkRegistry,
    private readonly notifyOps: (messageKey: string) => void = () => {},
  ) {}

  get activeCount(): number {
    return this.active.length;
  }

  /** Removes leftover ticking areas from a previous session. */
  cleanup(dim: HostDimension): void {
    for (let i = 0; i < MAX_AREAS; i++) dim.command(`tickingarea remove ${areaName(i)}`);
  }

  cancelAll(): void {
    for (const b of this.active) this.release(b);
    this.active.length = 0;
    // Data may have been cleared: search from the inner edge again.
    this.frontier.clear();
  }

  /** True when work() has something to do this tick: a loaded batch to sample, a batch to check or to release. */
  ready(now: number): boolean {
    for (const b of this.active) {
      if (b.done || b.loaded) return true;
      if (now > b.startedAt && b.checkedAt !== now) return true;
    }
    return false;
  }

  update(players: readonly PlayerFocus[], now: number, opts: GenOptions): void {
    this.opts = opts;
    while (this.active.length > opts.concurrency) this.release(this.active.pop()!);
    if (opts.paused || now < this.backoffUntil) return;
    while (this.active.length < opts.concurrency) {
      const c = this.findCandidate(players, now, opts.priority);
      if (!c) return;
      if (!this.start(c.dim, c.cx, c.cz, now, opts.batch)) return;
    }
  }

  private findCandidate(
    players: readonly PlayerFocus[],
    now: number,
    priority: number,
  ): { dim: HostDimension; cx: number; cz: number } | undefined {
    let best: { dim: HostDimension; cx: number; cz: number } | undefined;
    let bestScore = Infinity;
    for (const p of players) {
      const pcx = Math.floor(p.x / 16);
      const pcz = Math.floor(p.z / 16);
      const rin = p.loadedRadius;
      const rout = Math.min(p.lodRadius, MAX_LOD_CHUNKS);
      if (rout <= rin) continue;
      const di = p.dim.index;
      const f = this.frontier.get(p.id);
      let start = rin + 1;
      if (f && Math.abs(f.cx - pcx) <= 1 && Math.abs(f.cz - pcz) <= 1) start = Math.max(start, f.ring - 2);
      const dl = Math.hypot(p.dirX, p.dirZ) || 1;
      let firstRing = -1;
      for (let ring = start; ring <= rout; ring++) {
        for (let dz = -ring; dz <= ring; dz++) {
          const edge = dz === -ring || dz === ring;
          for (let dx = -ring; dx <= ring; dx += edge ? 1 : 2 * ring) {
            const d2 = dx * dx + dz * dz;
            if (d2 > rout * rout || d2 <= rin * rin) continue;
            const cx = pcx + dx;
            const cz = pcz + dz;
            if (this.store.has(di, cx, cz) || this.registry.busy(di, cx, cz, now) || this.inActive(di, cx, cz)) continue;
            const d = Math.sqrt(d2);
            const cos = (dx * p.dirX + dz * p.dirZ) / (d * dl);
            const s =
              priority === PRIORITY_NEAREST ? d : priority === PRIORITY_VIEW ? d * (1 + 2 * (1 - cos)) : d * (1 + 0.5 * (1 - cos));
            if (s < bestScore) {
              bestScore = s;
              best = { dim: p.dim, cx, cz };
            }
            if (firstRing < 0) firstRing = ring;
          }
        }
        // Scores grow at least linearly with the ring, so a few rings past the first hit are enough.
        if (firstRing >= 0 && ring >= firstRing + (priority === PRIORITY_NEAREST ? 0 : 3)) break;
      }
      this.frontier.set(p.id, { cx: pcx, cz: pcz, ring: firstRing >= 0 ? firstRing : rout });
    }
    if (this.frontier.size > players.length) {
      for (const id of [...this.frontier.keys()]) if (!players.some((p) => p.id === id)) this.frontier.delete(id);
    }
    return best;
  }

  private inActive(dim: number, cx: number, cz: number): boolean {
    for (const b of this.active) {
      if (b.dim.index === dim && cx >= b.bx0 && cx < b.bx0 + b.size && cz >= b.bz0 && cz < b.bz0 + b.size) return true;
    }
    return false;
  }

  private start(dim: HostDimension, cx: number, cz: number, now: number, size: number): boolean {
    const used = new Set(this.active.map((b) => b.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const bx0 = Math.floor(cx / size) * size;
    const bz0 = Math.floor(cz / size) * size;
    const x1 = (bx0 - 1) * 16;
    const z1 = (bz0 - 1) * 16;
    const x2 = (bx0 + size + 1) * 16 - 1;
    const z2 = (bz0 + size + 1) * 16 - 1;
    let ok = false;
    try {
      ok = dim.command(`tickingarea add ${x1} 0 ${z1} ${x2} 0 ${z2} ${areaName(slot)}`);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.backoffUntil = now + GEN_BACKOFF_TICKS;
      this.failures++;
      if (!this.notified) {
        this.notified = true;
        this.notifyOps('dl.msg.ticking_limit');
      }
      return false;
    }
    this.active.push({ slot, dim, bx0, bz0, size, startedAt: now, checkedAt: -1, loaded: false, done: false, cancelled: false });
    return true;
  }

  private release(b: Batch): void {
    b.cancelled = true;
    try {
      b.dim.command(`tickingarea remove ${areaName(b.slot)}`);
    } catch {
      // The area may already be gone; nothing else to do.
    }
  }

  /** Advances active batches: waits for loading, samples, releases. Returns false when idle. */
  *work(now: number): Generator<void, boolean, void> {
    const opts = this.opts;
    if (!opts) return false;
    for (const b of this.active) {
      if (b.done) continue;
      if (!b.loaded) {
        if (now <= b.startedAt || b.checkedAt === now) continue;
        b.checkedAt = now;
        let all = true;
        for (let cz = b.bz0; cz < b.bz0 + b.size && all; cz++) {
          for (let cx = b.bx0; cx < b.bx0 + b.size; cx++) {
            if (!b.dim.isChunkLoaded(cx * 16 + 8, cz * 16 + 8)) {
              all = false;
              break;
            }
          }
        }
        if (!all) {
          if (now - b.startedAt > GEN_TIMEOUT_TICKS) {
            for (let cz = b.bz0; cz < b.bz0 + b.size; cz++)
              for (let cx = b.bx0; cx < b.bx0 + b.size; cx++) this.registry.fail(b.dim.index, cx, cz, now + FAILED_CHUNK_TICKS);
            b.done = true;
            this.failures++;
          }
          continue;
        }
        b.loaded = true;
      }
      const di = b.dim.index;
      for (let cz = b.bz0; cz < b.bz0 + b.size && !b.cancelled; cz++) {
        for (let cx = b.bx0; cx < b.bx0 + b.size && !b.cancelled; cx++) {
          if (!this.store.isStale(di, cx, cz, now, Infinity)) continue;
          const key = WorkRegistry.key(di, cx, cz);
          if (this.registry.inFlight.has(key)) continue;
          this.registry.inFlight.add(key);
          let lod;
          try {
            lod = yield* sampleChunk(b.dim, cx, cz, opts.res, opts.sampler);
          } finally {
            this.registry.inFlight.delete(key);
          }
          if (lod) {
            this.store.put(di, cx, cz, lod, now);
            this.generated++;
          } else {
            this.registry.fail(di, cx, cz, now + FAILED_CHUNK_TICKS);
          }
        }
      }
      b.done = true;
    }
    let did = false;
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].done && !this.active[i].cancelled) {
        this.release(this.active[i]);
        this.active.splice(i, 1);
        did = true;
      }
    }
    return did;
  }
}
