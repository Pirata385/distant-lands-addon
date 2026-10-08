/**
 * Scene helpers: renders what a player would see (real chunks + LOD particles) next to the ground truth (all terrain
 * at full detail) and measures the LOD band. Used by preview.test.ts and scripts/preview.ts.
 */
import { join } from 'node:path';
import { startWorld, ticks, fake, FakePlayer } from '../sim/harness';
export { finish } from '../sim/harness';
import { newFrame, renderSurface, renderQuads, fog, writePng, rayDir, Camera, Quad, Surface, Frame } from './raster';
import { applyTint, baseColor, isDecoration, rgb } from '../../src/core/palette';
import { fogEnd } from '../../src/core/fog';

export const OUT = join(import.meta.dirname, '..', '..', 'test-output', 'previews');
const SKY = 0x9cc3ff;
const FOG = 0xabd2ff;

/** True surface (same rules as the sampler: decorations are looked through, snow layers keep ground height). */
function truthSurface(dim: any): Surface {
  return (x, z) => {
    const col = dim.column(x, z);
    if (!col) return undefined;
    let i = 0;
    while (i < col.blocks.length && isDecoration(col.blocks[i].typeId)) i++;
    const b = col.blocks[i] ?? { y: col.ground, typeId: 'minecraft:stone' };
    if (b.typeId === 'minecraft:snow_layer') return { top: b.y, color: rgb(249, 254, 254) };
    const block = dim.blockAt(x, b.y, z);
    const mc = block.getComponent('minecraft:map_color');
    const base = baseColor(b.typeId) ?? 0x808080;
    const color = mc ? applyTint(base, mc.tintedColor, mc.color) : base;
    return { top: b.y + 1, color };
  };
}

function lodQuads(p: FakePlayer): Quad[] {
  const out: Quad[] = [];
  for (const q of p.particles) {
    const lit = q.vars.get('variable.l0') ?? 1;
    const color = rgb(
      (q.vars.get('variable.cr') ?? 0) * 255 * lit,
      (q.vars.get('variable.cg') ?? 0) * 255 * lit,
      (q.vars.get('variable.cb') ?? 0) * 255 * lit,
    );
    out.push({
      kind: q.effect === 'dl:lod_top' ? 0 : 1,
      c: { x: q.x, y: q.y, z: q.z },
      a: q.vars.get('variable.sa') ?? 0,
      b: q.vars.get('variable.sb') ?? 0,
      color,
    });
  }
  return out;
}

export interface Metrics {
  band: number;
  /** Sky visible where the truth has terrain in the LOD band. */
  holes: number;
  /** Terrain visible but much farther than the truth (LOD slightly lower at grazing angles). */
  through: number;
  /** LOD much nearer than the truth (faces floating in front of real terrain). */
  floating: number;
  /** Mean vertical skyline difference per image column, in pixels. */
  skyline: number;
}

/** Classified pixels for the diff image: 0 ok, 1 hole, 2 silhouette, 3 see-through, 4 floating. */
let lastDiff: Uint8Array | undefined;

function compare(
  truth: Frame,
  seen: Frame,
  near: number,
  far: number,
  cam: Camera,
  surface: Surface,
): Metrics & { silhouette: number } {
  let band = 0;
  let holes = 0;
  let silhouette = 0;
  let through = 0;
  let floating = 0;
  const w = truth.width;
  // First seen terrain row per column: sky below it is a hole, sky above it is a silhouette difference.
  const firstRow = new Int32Array(w).fill(truth.height);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < seen.height; y++) {
      if (Number.isFinite(seen.depth[x + y * w])) {
        firstRow[x] = y;
        break;
      }
    }
  }
  lastDiff = new Uint8Array(truth.depth.length);
  for (let i = 0; i < truth.depth.length; i++) {
    const t = truth.depth[i];
    if (!(t > near && t < far)) continue;
    band++;
    const s = seen.depth[i];
    const y = Math.floor(i / w);
    if (!Number.isFinite(s)) {
      if (y > firstRow[i % w]) {
        holes++;
        lastDiff[i] = 1;
      } else {
        silhouette++;
        lastDiff[i] = 2;
      }
    } else if (s > t + Math.max(8, 0.12 * t)) {
      through++;
      lastDiff[i] = 3;
    } else if (s < t - Math.max(6, 0.08 * t)) {
      // Nearer than the truth: only a floating face if it stands clearly above the real surface where it was hit
      // (risers sit on cell borders, so the highest column within one block counts).
      const d = rayDir(cam, i % w, y);
      const hx = cam.eye.x + d.x * s;
      const hy = cam.eye.y + d.y * s;
      const hz = cam.eye.z + d.z * s;
      let top = -Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = surface(Math.floor(hx) + dx, Math.floor(hz) + dz);
          if (c && c.top > top) top = c.top;
        }
      }
      if (hy > top + Math.max(2.5, 0.03 * s)) {
        floating++;
        lastDiff[i] = 4;
      } else {
        lastDiff[i] = 0;
      }
    }
  }
  let diff = 0;
  for (let x = 0; x < truth.width; x++) {
    const top = (f: Frame) => {
      for (let y = 0; y < f.height; y++) if (Number.isFinite(f.depth[x + y * f.width])) return y;
      return f.height;
    };
    diff += Math.abs(top(truth) - top(seen));
  }
  return { band, holes, silhouette, through, floating, skyline: diff / truth.width };
}

const DIFF_COLORS = [0, 0xff0000, 0xffd000, 0x00a0ff, 0xff00ff];

function diffImage(seen: Uint32Array, diff: Uint8Array): Uint32Array {
  const out = new Uint32Array(seen.length);
  for (let i = 0; i < seen.length; i++) out[i] = diff[i] ? DIFF_COLORS[diff[i]] : seen[i];
  return out;
}

export interface Rendered {
  metrics: Metrics;
  width: number;
  height: number;
  /** Fogged pixels: ground truth, what the player sees, LOD only, vanilla (real chunks + vanilla fog). */
  truth: Uint32Array;
  seen: Uint32Array;
  lod: Uint32Array;
  vanilla: Uint32Array;
}

export async function scene(name: string, yaw: number, pitch: number, eyeLift: number, settings: string[] = []): Promise<Metrics> {
  return (await renderScene(name, yaw, pitch, eyeLift, settings)).metrics;
}

export async function renderScene(name: string, yaw: number, pitch: number, eyeLift: number, settings: string[] = []): Promise<Rendered> {
  await startWorld({ viewRadius: 6 });
  const dim = fake.dimensions.get('overworld') as any;
  const ground = dim.column(8, 8).ground;
  const p = fake.join(name, { x: 8, y: ground + 1 + eyeLift, z: 8 });
  p.viewDirection = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  fake.scriptEvent(undefined, 'dl:set', 'maxDistance=16');
  for (const kv of settings) fake.scriptEvent(undefined, 'dl:set', kv);
  await ticks(2000);
  const cam: Camera = { eye: p.getHeadLocation(), yaw, pitch, fov: (70 * Math.PI) / 180, width: 320, height: 180 };
  const surface = truthSurface(dim);
  const far = 16 * 16 + 8; // LOD drawn out to here
  const fogFar = fogEnd(16); // the add-on's horizon fog is complete here (inside the stair-stepped LOD edge)
  const truth = newFrame(cam.width, cam.height);
  renderSurface(truth, cam, surface, far);
  const seen = newFrame(cam.width, cam.height);
  renderSurface(seen, cam, surface, far, (x, z) => p.clientHas(Math.floor(x / 16), Math.floor(z / 16)));
  renderQuads(seen, cam, lodQuads(p));
  const lodOnly = newFrame(cam.width, cam.height);
  renderQuads(lodOnly, cam, lodQuads(p));
  const truthPx = fog(truth, 0.62 * fogFar, fogFar, FOG, SKY);
  const seenPx = fog(seen, 0.62 * fogFar, fogFar, FOG, SKY);
  const lodPx = fog(lodOnly, 0.62 * fogFar, fogFar, FOG, SKY);
  const vanillaFrame = newFrame(cam.width, cam.height);
  renderSurface(vanillaFrame, cam, surface, far, (x, z) => p.clientHas(Math.floor(x / 16), Math.floor(z / 16)));
  const vanillaEnd = p.viewRadius * 16;
  const vanillaPx = fog(vanillaFrame, 0.92 * vanillaEnd, vanillaEnd, FOG, SKY);
  writePng(join(OUT, `${name}-truth.png`), cam.width, cam.height, truthPx);
  writePng(join(OUT, `${name}-seen.png`), cam.width, cam.height, seenPx);
  writePng(join(OUT, `${name}-lod-only.png`), cam.width, cam.height, lodPx);
  writePng(join(OUT, `${name}-vanilla.png`), cam.width, cam.height, vanillaPx);
  // From just inside the real-terrain edge (LOD starts one chunk inside it) to where the fog hides everything.
  const m = compare(truth, seen, 88, fogFar, cam, surface);
  writePng(join(OUT, `${name}-diff.png`), cam.width, cam.height, diffImage(seenPx, lastDiff!));
  return { metrics: m, width: cam.width, height: cam.height, truth: truthPx, seen: seenPx, lod: lodPx, vanilla: vanillaPx };
}

