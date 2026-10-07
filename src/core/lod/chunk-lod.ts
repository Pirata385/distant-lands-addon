import { F_FOLIAGE, F_SNOW, F_VOID, F_WATER, NO_DATA } from '../flags';
import { rgb } from '../palette';

export { F_FOLIAGE, F_SNOW, F_VOID, F_WATER, NO_DATA };

/** Valid base sample resolutions (blocks per sample). */
export const RESOLUTIONS = [2, 4, 8] as const;

/** One detail level of a chunk: n×n cells of `size` blocks. Index = i + j * n (i along X, j along Z). */
export class LodLevel {
  readonly height: Int16Array;
  readonly color: Uint32Array;
  readonly flags: Uint8Array;
  readonly depth: Uint8Array;

  constructor(
    readonly size: number,
    readonly n: number,
  ) {
    const len = n * n;
    this.height = new Int16Array(len).fill(NO_DATA);
    this.color = new Uint32Array(len);
    this.flags = new Uint8Array(len);
    this.depth = new Uint8Array(len);
  }
}

/** Aggregated cell produced by {@link aggregate}. */
export interface CellOut {
  h: number;
  c: number;
  f: number;
  d: number;
}

/**
 * Merges `count` child cells into one.
 * Water wins when at least half of the known children are water (height = highest water surface);
 * otherwise the cell is land with the second-highest land height (keeps ridges, ignores single trees)
 * and the mean land colour. Children with NO_DATA are ignored.
 */
export function aggregate(
  hs: ArrayLike<number>,
  cs: ArrayLike<number>,
  fs: ArrayLike<number>,
  ds: ArrayLike<number>,
  count: number,
  out: CellOut,
): void {
  let water = 0;
  let land = 0;
  let voids = 0;
  let wMax = NO_DATA;
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wd = 0;
  let h1 = NO_DATA;
  let h2 = NO_DATA;
  let lr = 0;
  let lg = 0;
  let lb = 0;
  let foliage = 0;
  let snow = 0;
  for (let i = 0; i < count; i++) {
    const h = hs[i];
    const f = fs[i];
    if (h === NO_DATA) {
      if (f & F_VOID) voids++;
      continue;
    }
    const c = cs[i];
    if (f & F_WATER) {
      water++;
      if (h > wMax) wMax = h;
      wr += (c >> 16) & 255;
      wg += (c >> 8) & 255;
      wb += c & 255;
      wd += ds[i];
    } else {
      land++;
      if (h > h1) {
        h2 = h1;
        h1 = h;
      } else if (h > h2) {
        h2 = h;
      }
      lr += (c >> 16) & 255;
      lg += (c >> 8) & 255;
      lb += c & 255;
      if (f & F_FOLIAGE) foliage++;
      if (f & F_SNOW) snow++;
    }
  }
  const valid = water + land;
  if (valid === 0) {
    out.h = NO_DATA;
    out.c = 0;
    out.f = voids * 2 >= count && voids > 0 ? F_VOID : 0;
    out.d = 0;
    return;
  }
  if (water * 2 >= valid) {
    out.h = wMax;
    out.c = rgb(wr / water, wg / water, wb / water);
    out.f = F_WATER;
    out.d = Math.round(wd / water);
    return;
  }
  out.h = land >= 2 ? h2 : h1;
  out.c = rgb(lr / land, lg / land, lb / land);
  out.f = (foliage * 2 > land ? F_FOLIAGE : 0) | (snow * 2 >= land ? F_SNOW : 0);
  out.d = 0;
}

const sh = new Int32Array(4);
const sc = new Uint32Array(4);
const sf = new Uint8Array(4);
const sd = new Uint8Array(4);
const scratch: CellOut = { h: 0, c: 0, f: 0, d: 0 };

/** Level-of-detail data for one 16×16 chunk column. */
export class ChunkLod {
  readonly levels: LodLevel[] = [];
  /** Incremented by the store whenever the content changes. */
  version = 0;
  /** World tick of the last sampling; -1 when restored from storage (age unknown). */
  sampledAt = -1;

  constructor(readonly res: number) {
    if (!(RESOLUTIONS as readonly number[]).includes(res)) throw new RangeError(`bad LOD resolution ${res}`);
    for (let size = res; size <= 16; size *= 2) this.levels.push(new LodLevel(size, 16 / size));
  }

  get base(): LodLevel {
    return this.levels[0];
  }

  /** The level whose cells are `size` blocks wide, if it exists. */
  level(size: number): LodLevel | undefined {
    for (const l of this.levels) if (l.size === size) return l;
    return undefined;
  }

  /** Recomputes every level above the base from the base samples. */
  buildMips(): void {
    for (let k = 1; k < this.levels.length; k++) {
      const src = this.levels[k - 1];
      const dst = this.levels[k];
      for (let j = 0; j < dst.n; j++) {
        for (let i = 0; i < dst.n; i++) {
          let q = 0;
          for (let dj = 0; dj < 2; dj++) {
            for (let di = 0; di < 2; di++) {
              const si = 2 * i + di + (2 * j + dj) * src.n;
              sh[q] = src.height[si];
              sc[q] = src.color[si];
              sf[q] = src.flags[si];
              sd[q] = src.depth[si];
              q++;
            }
          }
          aggregate(sh, sc, sf, sd, 4, scratch);
          const di = i + j * dst.n;
          dst.height[di] = scratch.h;
          dst.color[di] = scratch.c;
          dst.flags[di] = scratch.f;
          dst.depth[di] = scratch.d;
        }
      }
    }
  }
}

/** RGB565 quantisation used by the codec; also used to compare content independent of storage. */
export function quantizeColor(c: number): number {
  const r5 = Math.floor((((c >> 16) & 255) * 31 + 127) / 255);
  const g6 = Math.floor((((c >> 8) & 255) * 63 + 127) / 255);
  const b5 = Math.floor(((c & 255) * 31 + 127) / 255);
  return (r5 << 11) | (g6 << 5) | b5;
}

/** Inverse of {@link quantizeColor}. */
export function expandColor(q: number): number {
  return rgb((((q >> 11) & 31) * 255) / 31, (((q >> 5) & 63) * 255) / 63, ((q & 31) * 255) / 31);
}

/** Depth stored in 4 bits, 3 blocks per step. */
export function quantizeDepth(d: number): number {
  return Math.min(15, Math.round(d / 3));
}

/** True when two chunks would encode to the same stored data (ignores sub-quantisation colour noise). */
export function sameContent(a: ChunkLod, b: ChunkLod): boolean {
  if (a.res !== b.res) return false;
  const la = a.base;
  const lb = b.base;
  for (let i = 0; i < la.height.length; i++) {
    if (la.height[i] !== lb.height[i] || la.flags[i] !== lb.flags[i]) return false;
    if (la.height[i] === NO_DATA) continue;
    if (quantizeColor(la.color[i]) !== quantizeColor(lb.color[i])) return false;
    if (quantizeDepth(la.depth[i]) !== quantizeDepth(lb.depth[i])) return false;
  }
  return true;
}
