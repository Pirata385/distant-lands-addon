import type { HostPlayer } from './types';

/** User-provided id for our entry on the /fog command stack. */
export const FOG_USER_ID = 'dl_lod';
/** LOD distances (chunks) that have a fog definition in the resource pack. */
export const FOG_DISTANCES = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];

export const FOG_MODE_HORIZON = 0;
export const FOG_MODE_VANILLA = 1;
export const FOG_MODE_ATMOSPHERIC = 2;

/** Fog definition id for a dimension, LOD distance and fog mode, or undefined to keep vanilla fog. */
export function fogIdFor(dimIndex: number, distanceChunks: number, mode: number): string | undefined {
  if (mode === FOG_MODE_VANILLA) return undefined;
  if (dimIndex !== 0 && dimIndex !== 2) return undefined;
  let step = FOG_DISTANCES[FOG_DISTANCES.length - 1];
  for (const d of FOG_DISTANCES) {
    if (d >= distanceChunks) {
      step = d;
      break;
    }
  }
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
