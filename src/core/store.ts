import { ChunkLod, sameContent } from './lod/chunk-lod';
import { CodecError, REGION_CHUNKS, decodeRegion, encodeRegion } from './lod/codec';
import { Lru } from './util/lru';

/** Minimal key/value persistence (world dynamic properties in game). */
export interface KV {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
  keys(): string[];
  totalBytes(): number;
}

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

export interface StoreStats {
  regionsInMemory: number;
  chunksInMemory: number;
  dirtyRegions: number;
  persistedRegions: number;
  corruptRegions: number;
  bytes: number;
}

/**
 * LOD data cache: an LRU of decoded 8×8-chunk regions in memory, backed by dynamic properties.
 * Chunk versions come from a single counter so they never repeat, even across evictions.
 */
export class LodStore {
  private readonly regions: Lru<string, Region>;
  private readonly staleChunks = new Set<string>();
  private persisted: Set<string> | undefined;
  private versionCounter = 0;
  /** Most recently used region, checked before the LRU (scans touch the same region many times in a row). */
  private lastRegion: Region | undefined;
  private corrupt = 0;
  /** Incremented whenever any chunk content changes. */
  dataEpoch = 0;

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

  /** Stores freshly sampled data. Returns true when the content changed. */
  put(dim: number, cx: number, cz: number, lod: ChunkLod, now: number): boolean {
    const region = this.region(dim, regionOf(cx), regionOf(cz));
    const i = localIndex(cx, cz);
    const old = region.chunks[i];
    this.staleChunks.delete(chunkKey(dim, cx, cz));
    if (old && sameContent(old, lod)) {
      old.sampledAt = now;
      return false;
    }
    lod.sampledAt = now;
    lod.version = ++this.versionCounter;
    region.chunks[i] = lod;
    region.dirty = true;
    this.dataEpoch++;
    return true;
  }

  /** Flags a chunk for resampling (block changed). */
  markDirty(dim: number, cx: number, cz: number): void {
    this.staleChunks.add(chunkKey(dim, cx, cz));
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
    if (lod.res !== this.opts.res || lod.sampledAt < 0) return true;
    return now - lod.sampledAt > maxAge;
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
   * Deletes persisted regions, farthest from the given chunk positions first, until storage is within budget.
   * Returns the number of regions removed.
   */
  evictStorage(points: ReadonlyArray<{ dim: number; cx: number; cz: number }>, budgetBytes: number): number {
    if (this.kv.totalBytes() <= budgetBytes) return 0;
    const keys = [...this.persistedKeys()];
    const scored = keys.map((key) => {
      const p = parseRegionKey(key);
      let best = Infinity;
      if (p) {
        const cx = p.rx * SIZE + SIZE / 2;
        const cz = p.rz * SIZE + SIZE / 2;
        for (const pt of points) {
          if (pt.dim !== p.dim) continue;
          const d = Math.hypot(pt.cx - cx, pt.cz - cz);
          if (d < best) best = d;
        }
      }
      return { key, d: best };
    });
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
          if (c) c.version = ++this.versionCounter;
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
