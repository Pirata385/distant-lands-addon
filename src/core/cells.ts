import { aggregate, ChunkLod } from './lod/chunk-lod';
import { NO_DATA } from './flags';
import type { CellData, CellLookup } from './mesher';
import type { LodStore } from './store';

interface Scratch {
  h: Int32Array;
  c: Uint32Array;
  f: Uint8Array;
  d: Uint8Array;
}

const scratch: Scratch[] = [0, 1, 2].map(() => ({
  h: new Int32Array(4),
  c: new Uint32Array(4),
  f: new Uint8Array(4),
  d: new Uint8Array(4),
}));

/**
 * Cell lookups backed by the LOD store. Cells up to a chunk come from the chunk's mip levels (requests finer than
 * the stored resolution use the base level); 32/64-block cells aggregate their quadrants recursively, exactly like
 * the chunk mips do.
 */
export class StoreLookup implements CellLookup {
  private lastCx = NaN;
  private lastCz = NaN;
  private lastLod: ChunkLod | undefined;
  private epoch = -1;

  constructor(
    private readonly store: LodStore,
    private readonly dim: number,
  ) {}

  private chunk(cx: number, cz: number): ChunkLod | undefined {
    if (this.epoch !== this.store.dataEpoch || cx !== this.lastCx || cz !== this.lastCz) {
      this.epoch = this.store.dataEpoch;
      this.lastCx = cx;
      this.lastCz = cz;
      this.lastLod = this.store.get(this.dim, cx, cz);
    }
    return this.lastLod;
  }

  cell(size: number, x: number, z: number, out: CellData): boolean {
    if (size > 16) return this.big(size, x, z, out, 0);
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const lod = this.chunk(cx, cz);
    if (!lod) return false;
    let level = lod.level(size);
    if (!level) {
      if (size >= lod.res) return false;
      level = lod.base;
    }
    const i = Math.floor((x - cx * 16) / level.size);
    const j = Math.floor((z - cz * 16) / level.size);
    const k = i + j * level.n;
    const h = level.height[k];
    if (h === NO_DATA) return false;
    out.h = h;
    out.c = level.color[k];
    out.f = level.flags[k];
    out.d = level.depth[k];
    return true;
  }

  private big(size: number, x: number, z: number, out: CellData, depth: number): boolean {
    const half = size / 2;
    const sc = scratch[depth];
    let q = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) {
        const ok =
          half > 16
            ? this.big(half, x + dx * half, z + dz * half, out, depth + 1)
            : this.cell(half, x + dx * half, z + dz * half, out);
        sc.h[q] = ok ? out.h : NO_DATA;
        sc.c[q] = ok ? out.c : 0;
        sc.f[q] = ok ? out.f : 0;
        sc.d[q] = ok ? out.d : 0;
        q++;
      }
    }
    aggregate(sc.h, sc.c, sc.f, sc.d, 4, out);
    return out.h !== NO_DATA;
  }
}
