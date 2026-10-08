import type { HostDimension } from './types';

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
];

/**
 * Estimates the vanilla loaded chunk radius around a block position: in 8 directions, binary-search the farthest
 * loaded chunk and take its real distance (a lower bound of the radius; diagonal probes land on rounded chunks), then
 * round the median up. The median is robust against ticking areas or other players loading extra chunks.
 */
export function detectRadius(dim: HostDimension, px: number, pz: number, max: number): number {
  const pcx = Math.floor(px / 16);
  const pcz = Math.floor(pz / 16);
  const loaded = (cx: number, cz: number): boolean => {
    try {
      return dim.isChunkLoaded(cx * 16 + 8, cz * 16 + 8);
    } catch {
      return false;
    }
  };
  if (!loaded(pcx, pcz)) return 0;
  const found: number[] = [];
  for (const [dx, dz] of DIRECTIONS) {
    let lo = 0;
    let hi = max;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (loaded(pcx + Math.round(dx * mid), pcz + Math.round(dz * mid))) lo = mid;
      else hi = mid - 1;
    }
    found.push(Math.hypot(Math.round(dx * lo), Math.round(dz * lo)));
  }
  found.sort((a, b) => a - b);
  return Math.ceil((found[3] + found[4]) / 2 - 1e-6);
}
