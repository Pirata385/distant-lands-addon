export interface HudStats {
  quads: number;
  tiles: number;
  /** Particles spawned per second for this player. */
  spawnRate: number;
  /** Chunks of LOD data in memory. */
  cached: number;
  /** Pending capture candidates + active generation batches. */
  genQueue: number;
  /** Average script milliseconds per tick. */
  ms: number;
  /** Detected vanilla radius (chunks). */
  radius: number;
  /** LOD distance (chunks). */
  distance: number;
  /** Effective refresh interval (s). */
  refresh: number;
  paused: boolean;
}

/** One-line action bar text. */
export function formatHud(s: HudStats): string {
  const state = s.paused ? ' §6paused§r' : '';
  return (
    `§bLOD§r ${s.quads} quads · ${s.tiles} tiles · ${s.spawnRate}/s · ` +
    `R ${s.radius}→${s.distance} · cache ${s.cached} · gen ${s.genQueue} · ${s.ms.toFixed(1)} ms · ↻${Math.round(s.refresh)}s${state}`
  );
}
