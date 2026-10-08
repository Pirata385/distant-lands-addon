import type { HostDimension } from './types';

/** What the data-acquisition subsystems need to know about a player. */
export interface PlayerFocus {
  id: string;
  dim: HostDimension;
  /** Block position. */
  x: number;
  z: number;
  /** Horizontal view direction. */
  dirX: number;
  dirZ: number;
  /** Detected vanilla loaded radius in chunks. */
  loadedRadius: number;
  /** LOD radius in chunks. */
  lodRadius: number;
  /** Flying/gliding fast (generation may pause). */
  flying: boolean;
}

/** Chunks currently being sampled and chunks that recently failed, shared by capture and generation. */
export class WorkRegistry {
  readonly inFlight = new Set<string>();
  private readonly failedUntil = new Map<string, number>();

  static key(dim: number, cx: number, cz: number): string {
    return `${dim}:${cx}:${cz}`;
  }

  busy(dim: number, cx: number, cz: number, now: number): boolean {
    const k = WorkRegistry.key(dim, cx, cz);
    if (this.inFlight.has(k)) return true;
    const until = this.failedUntil.get(k);
    if (until === undefined) return false;
    if (until <= now) {
      this.failedUntil.delete(k);
      return false;
    }
    return true;
  }

  fail(dim: number, cx: number, cz: number, until: number): void {
    this.failedUntil.set(WorkRegistry.key(dim, cx, cz), until);
    if (this.failedUntil.size > 20000) this.failedUntil.clear();
  }
}
