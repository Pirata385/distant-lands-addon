/** Composes documentation images from rendered scenes (simulated, not in-game screenshots). */
import { join } from 'node:path';
import { renderScene, finish, OUT } from './scene';
import { writePng } from './raster';

export const PNG_DIR = OUT;

/** Stacks panels vertically with a 4 px separator, each scaled up 2x. */
function stack(panels: Uint32Array[], w: number, h: number): { px: Uint32Array; w: number; h: number } {
  const S = 2;
  const W = w * S;
  const H = (h * S + 4) * panels.length - 4;
  const px = new Uint32Array(W * H).fill(0x202020);
  panels.forEach((p, k) => {
    const y0 = k * (h * S + 4);
    for (let y = 0; y < h * S; y++) for (let x = 0; x < W; x++) px[x + (y0 + y) * W] = p[Math.floor(x / S) + Math.floor(y / S) * w];
  });
  return { px, w: W, h: H };
}

export async function composeComparison(outDir: string): Promise<void> {
  for (const [name, yaw, pitch, lift] of [
    ['valley', (-3 * Math.PI) / 4, -0.18, 30],
    ['coast', Math.PI, -0.2, 40],
  ] as const) {
    const r = await renderScene(`docs-${name}`, yaw, pitch, lift);
    const img = stack([r.vanilla, r.seen, r.truth], r.width, r.height);
    writePng(join(outDir, `compare-${name}.png`), img.w, img.h, img.px);
    const lod = stack([r.lod], r.width, r.height);
    writePng(join(outDir, `lod-only-${name}.png`), lod.w, lod.h, lod.px);
  }
  finish();
}
