import type { HostPlayer } from './types';

/** User-provided id for our entry on the /fog command stack. */
export const FOG_USER_ID = 'dl_lod';
/** LOD distances (chunks) that have a fog definition in the resource pack: every distance from 6 to 32. */
export const FOG_DISTANCES = Array.from({ length: 27 }, (_, i) => i + 6);

/**
 * Where a fog for LOD distance `d` (chunks) ends, in blocks. The LOD edge is stair-stepped at chunk granularity:
 * the nearest missing chunk can be ~20 blocks inside d·16, so the fog is complete a little before that.
 */
export function fogEnd(d: number): number {
  return d * 16 - 24;
}

export const FOG_MODE_HORIZON = 0;
export const FOG_MODE_VANILLA = 1;
export const FOG_MODE_ATMOSPHERIC = 2;

/**
 * Fog definition id for a dimension, the radius (chunks) out to which LOD is actually drawn, and fog mode; undefined
 * keeps vanilla fog (also when no LOD is drawn, e.g. the real terrain already reaches the LOD distance).
 */
export function fogIdFor(dimIndex: number, distanceChunks: number, mode: number): string | undefined {
  if (mode === FOG_MODE_VANILLA || distanceChunks <= 0) return undefined;
  if (dimIndex !== 0 && dimIndex !== 2) return undefined;
  // Round down: the fog must be complete before the LOD edge, or the edge shows against the sky.
  const step = Math.max(FOG_DISTANCES[0], Math.min(FOG_DISTANCES[FOG_DISTANCES.length - 1], Math.floor(distanceChunks)));
  const family = dimIndex === 2 ? 'end' : mode === FOG_MODE_ATMOSPHERIC ? 'haze' : 'horizon';
  return `dl:${family}_${step}`;
}

/**
 * Keeps each player's /fog stack entry in sync. The fog stack is saved with the world, so the first time we see a
 * player we always remove a possibly stale entry before pushing.
 */
export class FogManager {
  private readonly applied = new Map<string, string | null>();

  apply(player: HostPlayer, want: string | undefined): void {
    const cur = this.applied.get(player.id);
    const target = want ?? null;
    if (cur !== undefined && cur === target) return;
    if (cur !== null) player.runCommand(`fog @s remove ${FOG_USER_ID}`);
    if (target) player.runCommand(`fog @s push ${target} ${FOG_USER_ID}`);
    this.applied.set(player.id, target);
  }

  forget(id: string): void {
    this.applied.delete(id);
  }
}
