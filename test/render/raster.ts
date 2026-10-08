/**
 * Minimal CPU renderer for verifying LOD output: ray-marched heightfields (ground truth and the client's real chunks)
 * plus z-buffered particle quads (horizontal tops and camera-facing walls), with distance fog. Writes PNGs.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera {
  eye: V3;
  /** Radians; 0 looks toward +z, PI/2 toward +x. */
  yaw: number;
  /** Radians; negative looks down. */
  pitch: number;
  /** Vertical field of view (radians). */
  fov: number;
  width: number;
  height: number;
}

export interface Frame {
  width: number;
  height: number;
  /** Distance along the view ray (Infinity = sky). */
  depth: Float32Array;
  color: Uint32Array;
}

export function newFrame(w: number, h: number): Frame {
  return { width: w, height: h, depth: new Float32Array(w * h).fill(Infinity), color: new Uint32Array(w * h) };
}

function basis(cam: Camera) {
  const cp = Math.cos(cam.pitch);
  const fwd = { x: Math.sin(cam.yaw) * cp, y: Math.sin(cam.pitch), z: Math.cos(cam.yaw) * cp };
  // Right-handed (x east, y up, z south): right = forward x up.
  const right = { x: -Math.cos(cam.yaw), y: 0, z: Math.sin(cam.yaw) };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  return { fwd, right, up };
}

export function rayDir(cam: Camera, px: number, py: number): V3 {
  const { fwd, right, up } = basis(cam);
  const t = Math.tan(cam.fov / 2);
  const aspect = cam.width / cam.height;
  const sx = ((px + 0.5) / cam.width * 2 - 1) * t * aspect;
  const sy = (1 - (py + 0.5) / cam.height * 2) * t;
  const d = { x: fwd.x + right.x * sx + up.x * sy, y: fwd.y + right.y * sx + up.y * sy, z: fwd.z + right.z * sx + up.z * sy };
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / len, y: d.y / len, z: d.z / len };
}

/** Heightfield: top surface Y of the column (block Y + 1) and its colour; undefined = no column (void). */
export type Surface = (x: number, z: number) => { top: number; color: number } | undefined;

/**
 * Marches a ray through a column heightfield (1-block columns) until it hits a column or leaves `allow`.
 * Returns the hit distance and colour (side hits are shaded).
 */
export function march(eye: V3, d: V3, maxDist: number, surface: Surface, allow?: (x: number, z: number) => boolean): { t: number; color: number } | undefined {
  // DDA over the x/z grid.
  let x = Math.floor(eye.x);
  let z = Math.floor(eye.z);
  const stepX = d.x > 0 ? 1 : -1;
  const stepZ = d.z > 0 ? 1 : -1;
  const tdx = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
  const tdz = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
  let tmx = d.x !== 0 ? (d.x > 0 ? x + 1 - eye.x : eye.x - x) * tdx : Infinity;
  let tmz = d.z !== 0 ? (d.z > 0 ? z + 1 - eye.z : eye.z - z) * tdz : Infinity;
  let t = 0;
  let side = false;
  while (t < maxDist) {
    if (allow && !allow(x, z)) return undefined;
    const s = surface(x, z);
    if (s) {
      const yEnter = eye.y + d.y * t;
      const tExit = Math.min(tmx, tmz);
      const yExit = eye.y + d.y * tExit;
      if (yEnter <= s.top) return { t, color: side ? shade(s.color, 0.75) : s.color };
      if (yExit <= s.top) {
        const tHit = (s.top - eye.y) / d.y;
        return { t: tHit, color: s.color };
      }
    }
    if (tmx < tmz) {
      t = tmx;
      tmx += tdx;
      x += stepX;
    } else {
      t = tmz;
      tmz += tdz;
      z += stepZ;
    }
    side = true;
  }
  return undefined;
}

export function shade(c: number, f: number): number {
  const r = Math.min(255, ((c >> 16) & 255) * f);
  const g = Math.min(255, ((c >> 8) & 255) * f);
  const b = Math.min(255, (c & 255) * f);
  return (r << 16) | (g << 8) | b;
}

export function mixColor(a: number, b: number, t: number): number {
  const u = 1 - t;
  return (
    (Math.round(((a >> 16) & 255) * u + ((b >> 16) & 255) * t) << 16) |
    (Math.round(((a >> 8) & 255) * u + ((b >> 8) & 255) * t) << 8) |
    Math.round((a & 255) * u + (b & 255) * t)
  );
}

/** Renders a heightfield into the frame (keeps nearer existing samples). */
export function renderSurface(f: Frame, cam: Camera, surface: Surface, maxDist: number, allow?: (x: number, z: number) => boolean): void {
  for (let py = 0; py < f.height; py++) {
    for (let px = 0; px < f.width; px++) {
      const d = rayDir(cam, px, py);
      const hit = march(cam.eye, d, maxDist, surface, allow);
      const i = px + py * f.width;
      if (hit && hit.t < f.depth[i]) {
        f.depth[i] = hit.t;
        f.color[i] = hit.color;
      }
    }
  }
}

export interface Quad {
  /** 0 = horizontal top, 1 = camera-facing wall. */
  kind: number;
  c: V3;
  a: number;
  b: number;
  color: number;
}

/** Rasterises particle quads with a z-buffer (depth = distance from the eye). */
export function renderQuads(f: Frame, cam: Camera, quads: readonly Quad[]): void {
  const { fwd, right, up } = basis(cam);
  const t = Math.tan(cam.fov / 2);
  const aspect = cam.width / cam.height;
  const project = (p: V3) => {
    const rx = p.x - cam.eye.x;
    const ry = p.y - cam.eye.y;
    const rz = p.z - cam.eye.z;
    const zc = rx * fwd.x + ry * fwd.y + rz * fwd.z;
    const xc = rx * right.x + ry * right.y + rz * right.z;
    const yc = rx * up.x + ry * up.y + rz * up.z;
    return { sx: ((xc / (zc * t * aspect)) + 1) * 0.5 * cam.width, sy: (1 - yc / (zc * t)) * 0.5 * cam.height, zc, dist: Math.hypot(rx, ry, rz) };
  };
  for (const q of quads) {
    let corners: V3[];
    if (q.kind === 0) {
      corners = [
        { x: q.c.x - q.a, y: q.c.y, z: q.c.z - q.a },
        { x: q.c.x + q.a, y: q.c.y, z: q.c.z - q.a },
        { x: q.c.x + q.a, y: q.c.y, z: q.c.z + q.a },
        { x: q.c.x - q.a, y: q.c.y, z: q.c.z + q.a },
      ];
    } else {
      const tx = cam.eye.x - q.c.x;
      const tz = cam.eye.z - q.c.z;
      const l = Math.hypot(tx, tz) || 1;
      const rx = -tz / l;
      const rz = tx / l;
      corners = [
        { x: q.c.x - rx * q.a, y: q.c.y - q.b, z: q.c.z - rz * q.a },
        { x: q.c.x + rx * q.a, y: q.c.y - q.b, z: q.c.z + rz * q.a },
        { x: q.c.x + rx * q.a, y: q.c.y + q.b, z: q.c.z + rz * q.a },
        { x: q.c.x - rx * q.a, y: q.c.y + q.b, z: q.c.z - rz * q.a },
      ];
    }
    const p = corners.map(project);
    if (p.some((v) => v.zc < 0.5)) continue;
    tri(f, p[0], p[1], p[2], q.color);
    tri(f, p[0], p[2], p[3], q.color);
  }
}

interface P {
  sx: number;
  sy: number;
  zc: number;
  dist: number;
}

function tri(f: Frame, a: P, b: P, c: P, color: number): void {
  const minX = Math.max(0, Math.floor(Math.min(a.sx, b.sx, c.sx)));
  const maxX = Math.min(f.width - 1, Math.ceil(Math.max(a.sx, b.sx, c.sx)));
  const minY = Math.max(0, Math.floor(Math.min(a.sy, b.sy, c.sy)));
  const maxY = Math.min(f.height - 1, Math.ceil(Math.max(a.sy, b.sy, c.sy)));
  const area = (b.sx - a.sx) * (c.sy - a.sy) - (b.sy - a.sy) * (c.sx - a.sx);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b.sx - px) * (c.sy - py) - (b.sy - py) * (c.sx - px)) / area;
      const w1 = ((c.sx - px) * (a.sy - py) - (c.sy - py) * (a.sx - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      // Perspective-correct distance.
      const iz = w0 / a.zc + w1 / b.zc + w2 / c.zc;
      const dist = (w0 * a.dist / a.zc + w1 * b.dist / b.zc + w2 * c.dist / c.zc) / iz;
      const i = x + y * f.width;
      if (dist < f.depth[i]) {
        f.depth[i] = dist;
        f.color[i] = color;
      }
    }
  }
}

/** Applies linear distance fog toward `fogColor` (start/end in blocks); sky pixels become the fog/sky colour. */
export function fog(f: Frame, start: number, end: number, fogColor: number, sky: number): Uint32Array {
  const out = new Uint32Array(f.color.length);
  for (let i = 0; i < out.length; i++) {
    const d = f.depth[i];
    if (!Number.isFinite(d)) out[i] = sky;
    else out[i] = mixColor(f.color[i], fogColor, Math.max(0, Math.min(1, (d - start) / (end - start))));
  }
  return out;
}

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Writes an RGB PNG (pixels as 0xRRGGBB). */
export function writePng(path: string, width: number, height: number, pixels: Uint32Array): void {
  const raw = new Uint8Array((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const c = pixels[x + y * width];
      raw[o++] = (c >> 16) & 255;
      raw[o++] = (c >> 8) & 255;
      raw[o++] = c & 255;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]),
  );
}
