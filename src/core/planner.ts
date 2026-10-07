import { MAX_LOD_CHUNKS } from './settings';

/** A tile must cross a detail threshold by this factor before its cell size changes (anti-flicker). */
export const HYSTERESIS = 1.12;
/** Quadtree root size in blocks; also the largest cell. */
export const ROOT_SIZE = 64;
export const MAX_CELL = 64;

export interface PlanInput {
  /** Player block position. */
  px: number;
  pz: number;
  /** Chunks within this radius of the player's chunk are real terrain and excluded (-1 excludes nothing). */
  rinChunks: number;
  /** LOD radius in chunks (capped at 32). */
  routChunks: number;
  /** Base sample resolution in blocks. */
  res: number;
  /** Quality factor: larger = finer detail at a given distance. */
  quality: number;
  /** Previous plan: tile key -> cell size, for hysteresis. */
  prev?: ReadonlyMap<string, number>;
  /** Chunk tiles within rin + this many chunks use conservative (lowest-sample) heights. */
  conservativeChunks?: number;
}

export interface Tile {
  /** `${x0},${z0},${size}` */
  key: string;
  x0: number;
  z0: number;
  /** Tile size in blocks (16, 32 or 64). */
  size: number;
  /** Cell size in blocks (tiles larger than a chunk are one cell). */
  cell: number;
  /** Distance from the player to the tile centre, in blocks. */
  dist: number;
  /**
   * Near the real-terrain edge: heights are the lowest sample per cell, so faces stay under the real surface
   * (and self-cull) when the player walks into them.
   */
  conservative?: boolean;
}

/** Desired LOD cell size at distance `d` (blocks): res·2^⌊log2(d / (res·q))⌋, clamped to [res, 64]. */
export function cellSizeFor(d: number, res: number, q: number): number {
  const ratio = Math.max(d, 1) / (res * q);
  if (ratio < 2) return res;
  const size = res * 2 ** Math.floor(Math.log2(ratio));
  return size > MAX_CELL ? MAX_CELL : size;
}

/** Rough quad count for a plan (tops plus a share of walls). */
export function estimateQuads(tiles: readonly Tile[]): number {
  let n = 0;
  for (const t of tiles) {
    const k = t.size / t.cell;
    n += k * k;
  }
  return Math.round(n * 1.5);
}

/**
 * Selects LOD tiles around a player with a quadtree over 64-block roots. Big nodes become single cells when the
 * distance rule allows a cell at least that large at their nearest point; nodes touching the excluded (real
 * terrain) disk or the outer edge are split down to chunk tiles. Yields once per root.
 */
export function* planTiles(input: PlanInput): Generator<void, Tile[], void> {
  const rout = Math.min(input.routChunks, MAX_LOD_CHUNKS);
  const rin = input.rinChunks;
  const { px, pz, res, quality, prev } = input;
  const pcx = Math.floor(px / 16);
  const pcz = Math.floor(pz / 16);
  const rout2 = rout * rout;
  const rin2 = rin >= 0 ? rin * rin : -1;
  const band = Math.max(0, rin) + (input.conservativeChunks ?? 0);
  const band2 = input.conservativeChunks ? band * band : -1;
  const tiles: Tile[] = [];
  if (rout < 0 || rin >= rout) return tiles;

  const visit = (x0: number, z0: number, size: number): void => {
    const c0x = x0 >> 4;
    const c0z = z0 >> 4;
    const span = size >> 4;
    const c1x = c0x + span - 1;
    const c1z = c0z + span - 1;
    const nx = (pcx < c0x ? c0x : pcx > c1x ? c1x : pcx) - pcx;
    const nz = (pcz < c0z ? c0z : pcz > c1z ? c1z : pcz) - pcz;
    const near2 = nx * nx + nz * nz;
    if (near2 > rout2) return;
    const key = `${x0},${z0},${size}`;
    if (size > 16) {
      const fx = Math.max(Math.abs(c0x - pcx), Math.abs(c1x - pcx));
      const fz = Math.max(Math.abs(c0z - pcz), Math.abs(c1z - pcz));
      if (near2 > rin2 && fx * fx + fz * fz <= rout2) {
        const bx = px < x0 ? x0 : px > x0 + size ? x0 + size : px;
        const bz = pz < z0 ? z0 : pz > z0 + size ? z0 + size : pz;
        let d = Math.hypot(px - bx, pz - bz);
        if (prev) d = prev.has(key) ? d * HYSTERESIS : d / HYSTERESIS;
        if (cellSizeFor(d, res, quality) >= size) {
          tiles.push({ key, x0, z0, size, cell: size, dist: Math.hypot(x0 + size / 2 - px, z0 + size / 2 - pz) });
          return;
        }
      }
      const h = size >> 1;
      visit(x0, z0, h);
      visit(x0 + h, z0, h);
      visit(x0, z0 + h, h);
      visit(x0 + h, z0 + h, h);
      return;
    }
    if (near2 <= rin2) return;
    const dist = Math.hypot(x0 + 8 - px, z0 + 8 - pz);
    let cell = Math.min(16, cellSizeFor(dist, res, quality));
    const p = prev?.get(key);
    if (p !== undefined && p !== cell && p <= 16) {
      const lo = Math.min(16, cellSizeFor(dist / HYSTERESIS, res, quality));
      const hi = Math.min(16, cellSizeFor(dist * HYSTERESIS, res, quality));
      if (p >= lo && p <= hi) cell = p;
    }
    const t: Tile = { key, x0, z0, size, cell, dist };
    if (near2 <= band2) t.conservative = true;
    tiles.push(t);
  };

  const minX = Math.floor(((pcx - rout) * 16) / ROOT_SIZE);
  const maxX = Math.floor(((pcx + rout) * 16) / ROOT_SIZE);
  const minZ = Math.floor(((pcz - rout) * 16) / ROOT_SIZE);
  const maxZ = Math.floor(((pcz + rout) * 16) / ROOT_SIZE);
  for (let rz = minZ; rz <= maxZ; rz++) {
    for (let rx = minX; rx <= maxX; rx++) {
      visit(rx * ROOT_SIZE, rz * ROOT_SIZE, ROOT_SIZE);
      yield;
    }
  }
  return tiles;
}
