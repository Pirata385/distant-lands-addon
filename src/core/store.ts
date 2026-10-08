import { ChunkLod, contentVersion, sameContent } from './lod/chunk-lod';
import { CodecError, REGION_CHUNKS, decodeRegion, encodeRegion } from './lod/codec';
import { Lru } from './util/lru';

import type { KV } from './types';

export type { KV };

export interface StoreOptions {
  /** Current base sample resolution (blocks). */
  res: number;
  /** Memory cache size in chunks. */
  memoryChunks: number;
  /** Write LOD data to the world. */
  persist: boolean;
}

export const REGION_PREFIX = 'dl:r:';

export function regionKey(dim: number, rx: number, rz: number): string {
  return `${REGION_PREFIX}${dim}:${rx}:${rz}`;
}

function parseRegionKey(key: string): { dim: number; rx: number; rz: number } | undefined {
  const parts = key.slice(REGION_PREFIX.length).split(':');
  if (parts.length !== 3) return undefined;
  const [dim, rx, rz] = parts.map(Number);
  if (![dim, rx, rz].every(Number.isInteger)) return undefined;
  return { dim, rx, rz };
}

interface Region {
  key: string;
  dim: number;
  rx: number;
  rz: number;
  chunks: (ChunkLod | undefined)[];
  dirty: boolean;
}

const SIZE = REGION_CHUNKS;

function regionOf(c: number): number {
  return Math.floor(c / SIZE);
}

function localIndex(cx: number, cz: number): number {
  return (cx - regionOf(cx) * SIZE) + (cz - regionOf(cz) * SIZE) * SIZE;
}

/** Block-edit marks kept at most (oldest dropped first; those chunks are refreshed by the periodic resample). */
const MAX_DIRTY_CHUNKS = 8192;

/** A position whose surroundings must stay stored: regions within `r` chunks are never evicted from storage. */
export interface KeepArea {
  dim: number;
  cx: number;
  cz: number;
  r: number;
}

export interface StoreStats {
  regionsInMemory: number;
  chunksInMemory: number;
  dirtyRegions: number;
  dirtyChunks: number;
  persistedRegions: number;
  corruptRegions: number;
  bytes: number;
}

/**
 * LOD data cache: an LRU of decoded 8×8-chunk regions in memory, backed by dynamic properties.
 * Chunk versions are content hashes, so they are stable across evictions and reloads.
 */
export class LodStore {
  private readonly regions: Lru<string, Region>;
  /** Chunks with block edits not yet sampled: key → tick of the latest edit. */
  private readonly staleChunks = new Map<string, number>();
  private persisted: Set<string> | undefined;
  /** True when the last storage eviction could not get under the budget without touching protected regions. */
  storageShort = false;
  /** Most recently used region, checked before the LRU (scans touch the same region many times in a row). */
  private lastRegion: Region | undefined;
  private corrupt = 0;
  /** Incremented whenever any chunk content changes. */
  dataEpoch = 0;
  /** Chunks sampled before this tick are stale (sampling options changed). */
  private staleBefore = -Infinity;

  constructor(
    private readonly kv: KV,
    private opts: StoreOptions,
  ) {
    this.regions = new Lru<string, Region>(Math.max(1, Math.ceil(opts.memoryChunks / (SIZE * SIZE))), (_k, r) =>
      this.onRegionEvicted(r),
    );
  }

  get res(): number {
    return this.opts.res;
  }

  configure(opts: Partial<StoreOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.regions.setCapacity(Math.max(1, Math.ceil(this.opts.memoryChunks / (SIZE * SIZE))));
  }

  get(dim: number, cx: number, cz: number): ChunkLod | undefined {
    return this.region(dim, regionOf(cx), regionOf(cz)).chunks[localIndex(cx, cz)];
  }

  has(dim: number, cx: number, cz: number): boolean {
    return this.get(dim, cx, cz) !== undefined;
  }

  version(dim: number, cx: number, cz: number): number {
    return this.get(dim, cx, cz)?.version ?? 0;
  }

  /**
   * Stores data sampled starting at tick `now`. Returns true when the content changed. Data at another resolution
   * than the current one (sampled just before a settings change) is ignored.
   */
  put(dim: number, cx: number, cz: number, lod: ChunkLod, now: number): boolean {
    if (lod.res !== this.opts.res) return false;
    const region = this.region(dim, regionOf(cx), regionOf(cz));
    const i = localIndex(cx, cz);
    const old = region.chunks[i];
    const key = chunkKey(dim, cx, cz);
    const editedAt = this.staleChunks.get(key);
    // An edit made after the sample started may not be in it: keep the chunk dirty.
    if (editedAt !== undefined && editedAt < now) this.staleChunks.delete(key);
    if (old && sameContent(old, lod)) {
      old.sampledAt = now;
      return false;
    }
    lod.sampledAt = now;
    lod.version = contentVersion(lod);
    region.chunks[i] = lod;
    region.dirty = true;
    this.dataEpoch++;
    return true;
  }

  /** Flags a chunk for resampling (a block changed at tick `tick`). */
  markDirty(dim: number, cx: number, cz: number, tick = -Infinity): void {
    const key = chunkKey(dim, cx, cz);
    this.staleChunks.delete(key); // re-insert: Map order is the eviction order
    this.staleChunks.set(key, tick);
    if (this.staleChunks.size > MAX_DIRTY_CHUNKS) this.staleChunks.delete(this.staleChunks.keys().next().value as string);
  }

  /** True when a block change was reported in the chunk since it was last sampled. */
  isDirty(dim: number, cx: number, cz: number): boolean {
    return this.staleChunks.has(chunkKey(dim, cx, cz));
  }

  /** True when the chunk has no data, was edited, has another resolution, unknown age, or is older than maxAge ticks. */
  isStale(dim: number, cx: number, cz: number, now: number, maxAge: number): boolean {
    if (this.staleChunks.has(chunkKey(dim, cx, cz))) return true;
    const lod = this.get(dim, cx, cz);
    if (!lod) return true;
    if (lod.res !== this.opts.res || lod.sampledAt < 0 || lod.sampledAt < this.staleBefore) return true;
    return now - lod.sampledAt > maxAge;
  }

  /** Marks everything sampled before `tick` as stale (e.g. the vegetation mode changed). */
  invalidateBefore(tick: number): void {
    this.staleBefore = tick;
  }

  /** Writes up to `maxRegions` dirty regions. Returns the number written. */
  flush(maxRegions: number): number {
    if (!this.opts.persist) return 0;
    let written = 0;
    for (const r of this.regions.values()) {
      if (written >= maxRegions) break;
      if (!r.dirty) continue;
      this.write(r);
      written++;
    }
    return written;
  }

  /**
   * Deletes persisted regions, farthest from the given areas first, until storage is within budget. Regions within
   * an area's radius are never deleted (they would only be generated again); when the budget cannot be met without
   * them, `storageShort` is set. Returns the number of regions removed.
   */
  evictStorage(areas: ReadonlyArray<KeepArea>, budgetBytes: number): number {
    this.storageShort = false;
    if (this.kv.totalBytes() <= budgetBytes) return 0;
    const keys = [...this.persistedKeys()];
    const scored: { key: string; d: number }[] = [];
    for (const key of keys) {
      const p = parseRegionKey(key);
      let best = Infinity;
      let keep = false;
      if (p) {
        const x0 = p.rx * SIZE;
        const z0 = p.rz * SIZE;
        for (const a of areas) {
          if (a.dim !== p.dim) continue;
          const d = Math.hypot(a.cx - (x0 + SIZE / 2), a.cz - (z0 + SIZE / 2));
          if (d < best) best = d;
          // Distance from the area centre to the nearest chunk of the region.
          const nx = Math.max(x0 - a.cx, 0, a.cx - (x0 + SIZE - 1));
          const nz = Math.max(z0 - a.cz, 0, a.cz - (z0 + SIZE - 1));
          if (Math.hypot(nx, nz) <= a.r) keep = true;
        }
      }
      if (!keep) scored.push({ key, d: best });
    }
    scored.sort((a, b) => b.d - a.d);
    let removed = 0;
    for (const { key } of scored) {
      if (this.kv.totalBytes() <= budgetBytes) break;
      this.kv.set(key, undefined);
      this.persistedKeys().delete(key);
      this.regions.delete(key);
      if (this.lastRegion?.key === key) this.lastRegion = undefined;
      removed++;
    }
    if (removed) this.dataEpoch++;
    this.storageShort = this.kv.totalBytes() > budgetBytes;
    return removed;
  }

  /** Removes all LOD data (memory and world). */
  clear(): void {
    for (const key of [...this.persistedKeys()]) this.kv.set(key, undefined);
    this.persistedKeys().clear();
    this.regions.clear();
    this.lastRegion = undefined;
    this.staleChunks.clear();
    this.dataEpoch++;
  }

  stats(): StoreStats {
    let chunks = 0;
    let dirty = 0;
    for (const r of this.regions.values()) {
      if (r.dirty) dirty++;
      for (const c of r.chunks) if (c) chunks++;
    }
    return {
      regionsInMemory: this.regions.size,
      chunksInMemory: chunks,
      dirtyRegions: dirty,
      dirtyChunks: this.staleChunks.size,
      persistedRegions: this.persistedKeys().size,
      corruptRegions: this.corrupt,
      bytes: this.kv.totalBytes(),
    };
  }

  private persistedKeys(): Set<string> {
    if (!this.persisted) {
      this.persisted = new Set(this.kv.keys().filter((k) => k.startsWith(REGION_PREFIX)));
    }
    return this.persisted;
  }

  private region(dim: number, rx: number, rz: number): Region {
    const last = this.lastRegion;
    if (last && last.dim === dim && last.rx === rx && last.rz === rz) return last;
    const key = regionKey(dim, rx, rz);
    let r = this.regions.get(key);
    if (r) {
      this.lastRegion = r;
      return r;
    }
    r = { key, dim, rx, rz, chunks: new Array(SIZE * SIZE).fill(undefined), dirty: false };
    const raw = this.persistedKeys().has(key) ? this.kv.get(key) : undefined;
    if (raw !== undefined) {
      try {
        const decoded = decodeRegion(raw);
        for (let i = 0; i < decoded.chunks.length; i++) {
          const c = decoded.chunks[i];
          if (c) c.version = contentVersion(c);
          r.chunks[i] = c;
        }
      } catch (e) {
        if (!(e instanceof CodecError)) throw e;
        this.corrupt++;
        this.kv.set(key, undefined);
        this.persistedKeys().delete(key);
      }
    }
    this.regions.set(key, r);
    this.lastRegion = r;
    return r;
  }

  private write(r: Region): void {
    const present = r.chunks.some((c) => c !== undefined);
    try {
      if (present) {
        this.kv.set(r.key, encodeRegion(r.chunks, this.opts.res));
        this.persistedKeys().add(r.key);
      } else {
        this.kv.set(r.key, undefined);
        this.persistedKeys().delete(r.key);
      }
      r.dirty = false;
    } catch (e) {
      if (!(e instanceof CodecError)) throw e;
      r.dirty = false;
    }
  }

  private onRegionEvicted(r: Region): void {
    if (this.lastRegion === r) this.lastRegion = undefined;
    if (r.dirty && this.opts.persist) this.write(r);
  }
}

function chunkKey(dim: number, cx: number, cz: number): string {
  return `${dim}:${cx}:${cz}`;
}
