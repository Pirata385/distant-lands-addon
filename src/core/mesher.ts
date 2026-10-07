import { F_FOLIAGE, F_SNOW, F_WATER, NO_DATA } from './flags';
import { STYLE_CARTO, mix, scale, styleColor } from './palette';
import type { Tile } from './planner';

/** Floats per quad: kind, x, y, z, a, b, r, g, b, level. x/z are relative to the tile origin (float32-safe). */
export const QUAD_STRIDE = 10;
/** Horizontal top face: a = b = half size. */
export const K_TOP = 0;
/** Camera-facing (lookat_y) wall: a = half width, b = half height. */
export const K_WALL = 1;
/** Tops sit this far below the surface so the particle centre is inside the real top block (self-culling). */
export const TOP_OFFSET = 0.15;

export interface CellData {
  h: number;
  c: number;
  f: number;
  d: number;
}

export interface CellLookup {
  /** Fills `out` with the cell of `size` blocks whose min corner is (x, z); false when there is no data. */
  cell(size: number, x: number, z: number, out: CellData): boolean;
  /** Lowest sampled height inside the cell (conservative tiles), when available. */
  minHeight?(size: number, x: number, z: number): number | undefined;
}

export interface StyleParams {
  /** STYLE_* from palette. */
  style: number;
  /** Relief shading strength 0..1. */
  relief: number;
  waterDepth: boolean;
}

const WALL_SHADE = 0.78;
const EARTH = 0x7a6a55;
const STONE = 0x8a8a8a;
const MERGE_TOLERANCE = 6;
const MERGE_FLAGS = F_WATER | F_SNOW | F_FOLIAGE;

function wallColor(top: number, f: number): number {
  if (f & F_SNOW) return scale(mix(top, STONE, 0.55), WALL_SHADE);
  if (f & F_FOLIAGE) return scale(top, 0.72);
  const r = (top >> 16) & 255;
  const g = (top >> 8) & 255;
  const b = top & 255;
  if (g > r && g > b) return scale(mix(top, EARTH, 0.45), WALL_SHADE);
  return scale(top, WALL_SHADE);
}

function similar(a: number, b: number): boolean {
  return (
    Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) <= MERGE_TOLERANCE &&
    Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= MERGE_TOLERANCE &&
    Math.abs((a & 255) - (b & 255)) <= MERGE_TOLERANCE
  );
}

const out: number[] = [];

function push(kind: number, x: number, y: number, z: number, a: number, b: number, color: number, level: number): void {
  out.push(kind, x, y, z, a, b, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, level);
}

const tmp: CellData = { h: 0, c: 0, f: 0, d: 0 };

/**
 * Builds the quads for one tile: a horizontal top per cell (merged into larger squares where neighbouring cells are
 * identical) and a camera-facing wall wherever a cell is at least one block above its lowest neighbour.
 */
export function meshTile(tile: Tile, lookup: CellLookup, style: StyleParams): Float32Array {
  const s = tile.cell;
  const n = tile.size / s;
  const w = n + 2;
  const hs = new Int32Array(w * w).fill(NO_DATA);
  const cs = new Uint32Array(w * w);
  const fs = new Uint8Array(w * w);
  const ds = new Uint8Array(w * w);
  for (let j = -1; j <= n; j++) {
    for (let i = -1; i <= n; i++) {
      const corner = (i < 0 || i >= n) && (j < 0 || j >= n);
      if (corner) continue;
      if (lookup.cell(s, tile.x0 + i * s, tile.z0 + j * s, tmp)) {
        const k = i + 1 + (j + 1) * w;
        let h = tmp.h;
        if (tile.conservative && !(tmp.f & F_WATER) && lookup.minHeight) {
          const m = lookup.minHeight(s, tile.x0 + i * s, tile.z0 + j * s);
          if (m !== undefined && m < h) h = m;
        }
        hs[k] = h;
        cs[k] = tmp.c;
        fs[k] = tmp.f;
        ds[k] = tmp.d;
      }
    }
  }

  const level = Math.max(0, Math.round(Math.log2(s)) - 1);
  const shaded = new Uint32Array(n * n);
  const has = new Uint8Array(n * n);
  out.length = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = i + 1 + (j + 1) * w;
      const h = hs[k];
      if (h === NO_DATA) continue;
      const f = fs[k];
      const hN = hs[k - w] === NO_DATA ? h : hs[k - w];
      const hW = hs[k - 1] === NO_DATA ? h : hs[k - 1];
      let factor = 1;
      if (style.relief > 0) {
        const dh = h - (hN + hW) / 2;
        const v = Math.max(-0.25, Math.min(0.25, (dh / (s * 0.5 + 1)) * 0.15));
        factor += style.relief * v;
      }
      if (style.style === STYLE_CARTO && (Math.floor(h / 16) !== Math.floor(hN / 16) || Math.floor(h / 16) !== Math.floor(hW / 16))) {
        factor *= 0.8;
      }
      if (style.waterDepth && f & F_WATER) factor *= Math.max(0.5, 1.1 - ds[k] * 0.02);
      const color = scale(styleColor(style.style, cs[k], h, f, level), factor);
      shaded[i + j * n] = color;
      has[i + j * n] = 1;

      if (f & F_WATER) continue;
      let hMin = h;
      for (const nk of [k - 1, k + 1, k - w, k + w]) {
        const nh = hs[nk];
        if (nh !== NO_DATA && nh < hMin) hMin = nh;
      }
      if (hMin <= h - 1) {
        push(
          K_WALL,
          i * s + s / 2,
          (h + hMin) / 2 - TOP_OFFSET,
          j * s + s / 2,
          s / 2,
          (h - hMin) / 2,
          wallColor(color, f),
          level,
        );
      }
    }
  }

  // Quadtree merge of tops. A uniform region is represented by its top-left cell index; -1 means "not uniform".
  const mergedColor = new Uint32Array(n * n);
  const gridIndex = (idx: number): number => (idx % n) + 1 + (Math.floor(idx / n) + 1) * w;
  const region = (i0: number, j0: number, m: number): number => {
    if (m === 1) {
      const idx = i0 + j0 * n;
      if (!has[idx]) return -1;
      mergedColor[idx] = shaded[idx];
      return idx;
    }
    const h2 = m >> 1;
    const a = region(i0, j0, h2);
    const b = region(i0 + h2, j0, h2);
    const c = region(i0, j0 + h2, h2);
    const d = region(i0 + h2, j0 + h2, h2);
    if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
      const ka = gridIndex(a);
      const hA = hs[ka];
      const fA = fs[ka] & MERGE_FLAGS;
      let uniform = true;
      for (const idx of [b, c, d]) {
        const kk = gridIndex(idx);
        if (hs[kk] !== hA || (fs[kk] & MERGE_FLAGS) !== fA || !similar(mergedColor[idx], mergedColor[a])) {
          uniform = false;
          break;
        }
      }
      if (uniform) {
        const ca = mergedColor[a];
        const cb = mergedColor[b];
        const cc = mergedColor[c];
        const cd = mergedColor[d];
        mergedColor[a] =
          ((((((ca >> 16) & 255) + ((cb >> 16) & 255) + ((cc >> 16) & 255) + ((cd >> 16) & 255)) / 4) | 0) << 16) |
          ((((((ca >> 8) & 255) + ((cb >> 8) & 255) + ((cc >> 8) & 255) + ((cd >> 8) & 255)) / 4) | 0) << 8) |
          ((((ca & 255) + (cb & 255) + (cc & 255) + (cd & 255)) / 4) | 0);
        return a;
      }
    }
    for (const [idx, ii, jj] of [
      [a, i0, j0],
      [b, i0 + h2, j0],
      [c, i0, j0 + h2],
      [d, i0 + h2, j0 + h2],
    ]) {
      if (idx >= 0) emitTop(ii, jj, h2, idx);
    }
    return -1;
  };
  const emitTop = (i0: number, j0: number, m: number, idx: number): void => {
    const h = hs[gridIndex(idx)];
    const size = m * s;
    push(K_TOP, i0 * s + size / 2, h - TOP_OFFSET, j0 * s + size / 2, size / 2, size / 2, mergedColor[idx], level);
  };
  const root = region(0, 0, n);
  if (root >= 0) emitTop(0, 0, n, root);
  return Float32Array.from(out);
}
