import { sampleChunk, SamplerOptions } from './sampler';
import type { LodStore } from './store';
import type { HostDimension } from './types';
import { PlayerFocus, WorkRegistry } from './work';

interface Candidate {
  dim: HostDimension;
  cx: number;
  cz: number;
}

/** Candidates gathered per collection pass. */
const MAX_CANDIDATES = 48;
/** Ticks between collection passes. */
const COLLECT_INTERVAL = 20;
/** Capture never scans farther than this (very large render distances). */
const MAX_CAPTURE_RADIUS = 40;
/** Retry delay for chunks that failed to sample. */
const RETRY_TICKS = 200;

/**
 * Passive capture: keeps LOD data fresh for chunks the players already have loaded.
 * Missing chunks first, then edited ones, then old ones; nearer the vanilla edge first since those become LOD soonest.
 */
export class Capture {
  private queue: Candidate[] = [];
  private pos = 0;
  private lastCollect = -Infinity;
  sampled = 0;

  constructor(
    private readonly store: LodStore,
    private readonly registry: WorkRegistry,
  ) {}

  get pending(): number {
    return this.queue.length - this.pos;
  }

  update(players: readonly PlayerFocus[], now: number, maxAgeTicks: number): void {
    if (now - this.lastCollect < COLLECT_INTERVAL && this.pending > 0) return;
    this.lastCollect = now;
    const missing: Candidate[] = [];
    const dirty: Candidate[] = [];
    const old: Candidate[] = [];
    const seen = new Set<string>();
    for (const p of players) {
      const r = Math.min(p.loadedRadius, MAX_CAPTURE_RADIUS);
      const pcx = Math.floor(p.x / 16);
      const pcz = Math.floor(p.z / 16);
      const di = p.dim.index;
      for (let ring = r; ring >= 0 && missing.length < MAX_CANDIDATES; ring--) {
        for (let dz = -ring; dz <= ring; dz++) {
          const step = dz === -ring || dz === ring ? 1 : 2 * ring;
          for (let dx = -ring; dx <= ring; dx += step || 1) {
            if (dx * dx + dz * dz > r * r) continue;
            const cx = pcx + dx;
            const cz = pcz + dz;
            const k = WorkRegistry.key(di, cx, cz);
            if (seen.has(k)) continue;
            seen.add(k);
            if (!this.store.isStale(di, cx, cz, now, maxAgeTicks) || this.registry.busy(di, cx, cz, now)) continue;
            if (!p.dim.isChunkLoaded(cx * 16 + 8, cz * 16 + 8)) continue;
            const c = { dim: p.dim, cx, cz };
            if (!this.store.has(di, cx, cz)) missing.push(c);
            else if (this.store.isDirty(di, cx, cz)) dirty.push(c);
            else if (old.length < MAX_CANDIDATES) old.push(c);
          }
        }
      }
    }
    this.queue = missing.concat(dirty, old).slice(0, MAX_CANDIDATES);
    this.pos = 0;
  }

  /** Samples the next candidate. Returns false when there was nothing to do. */
  *work(now: number, res: number, opts: SamplerOptions): Generator<void, boolean, void> {
    while (this.pos < this.queue.length) {
      const c = this.queue[this.pos++];
      const di = c.dim.index;
      if (this.registry.busy(di, c.cx, c.cz, now)) continue;
      const key = WorkRegistry.key(di, c.cx, c.cz);
      this.registry.inFlight.add(key);
      let lod;
      try {
        lod = yield* sampleChunk(c.dim, c.cx, c.cz, res, opts);
      } finally {
        this.registry.inFlight.delete(key);
      }
      if (lod) {
        this.store.put(di, c.cx, c.cz, lod, now);
        this.sampled++;
      } else {
        this.registry.fail(di, c.cx, c.cz, now + RETRY_TICKS);
      }
      return true;
    }
    return false;
  }
}
