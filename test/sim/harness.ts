/** Runs the production behavior-pack bundle against the fake Bedrock runtime. */
import { register } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

register('../fakes/loader.mjs', import.meta.url);

// The fakes must be imported through the same URLs the loader maps to (shared module instances).
const mc = await import('../fakes/mc-server.ts');
const uiMod = await import('../fakes/mc-server-ui.ts');
// @ts-ignore - plain ESM build script
const { build } = await import('../../scripts/build.mjs');

export const fake = mc.fake;
export const ui = uiMod.ui;
export type FakePlayer = InstanceType<typeof mc.Player>;
export type FakeOptions = import('../fakes/mc-server.ts').FakeOptions;

let bundleUrl: string | undefined;
let runs = 0;

async function bundle(): Promise<string> {
  if (!bundleUrl) {
    // Inside the repo so the package.json "type": "module" applies to the bundle.
    const base = join(import.meta.dirname, '..', '..', 'test-output');
    mkdirSync(base, { recursive: true });
    const out = mkdtempSync(join(base, 'sim-'));
    const r = await build({ outDir: out });
    bundleUrl = pathToFileURL(join(r.bpDir, 'scripts', 'main.js')).href;
  }
  return bundleUrl;
}

/** Fresh world + fresh instance of the add-on (module re-evaluated). */
export async function startWorld(opts: FakeOptions = {}): Promise<void> {
  mc.installFakeClock();
  fake.reset(opts);
  ui.reset();
  await import(`${await bundle()}?run=${++runs}`);
  fake.boot();
}

export function finish(): void {
  mc.restoreClock();
}

/** Advances `n` ticks, letting promise-based UI flows progress between ticks. */
export async function ticks(n: number, each?: (i: number) => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    fake.step();
    await Promise.resolve();
    await Promise.resolve();
    each?.(i);
  }
  await new Promise((r) => setImmediate(r));
}

export interface Coverage {
  ring: number;
  covered: number;
  ratio: number;
}

/** Fraction of chunks in the LOD ring (rin, rout] covered by at least one live top face. */
export function coverage(p: FakePlayer, rin: number, rout: number, filter?: (dx: number, dz: number) => boolean): Coverage {
  const cov = new Set<string>();
  for (const q of p.particles) {
    if (q.effect !== 'dl:lod_top') continue;
    const h = q.vars.get('variable.sa') ?? 0;
    for (let cz = Math.floor((q.z - h + 0.01) / 16); cz <= Math.floor((q.z + h - 0.01) / 16); cz++)
      for (let cx = Math.floor((q.x - h + 0.01) / 16); cx <= Math.floor((q.x + h - 0.01) / 16); cx++) cov.add(`${cx},${cz}`);
  }
  const pcx = Math.floor(p.location.x / 16);
  const pcz = Math.floor(p.location.z / 16);
  let ring = 0;
  let covered = 0;
  for (let dz = -rout; dz <= rout; dz++) {
    for (let dx = -rout; dx <= rout; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 <= rin * rin || d2 > rout * rout) continue;
      if (filter && !filter(dx, dz)) continue;
      ring++;
      if (cov.has(`${pcx + dx},${pcz + dz}`)) covered++;
    }
  }
  return { ring, covered, ratio: ring ? covered / ring : 1 };
}

/**
 * LOD faces that would visibly float over real terrain: in a chunk the client renders, not inside a block that makes
 * them expire, and above the real surface at their centre.
 */
export function overlapArtifacts(p: FakePlayer): number {
  const dim = p.dimension as any;
  let n = 0;
  for (const q of p.particles) {
    if (!p.clientHas(Math.floor(q.x / 16), Math.floor(q.z / 16))) continue;
    const def = fake.particleDefs.get(q.effect)!;
    const b = dim.blockAt(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z));
    if (def.expire.has(b.typeId)) continue;
    const col = dim.column(Math.floor(q.x), Math.floor(q.z));
    const surface = col ? (col.blocks.length ? col.blocks[0].y + 1 : col.ground + 1) : -Infinity;
    if (q.y > surface + 0.25) n++;
  }
  return n;
}
