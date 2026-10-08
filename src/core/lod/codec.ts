import { ChunkLod, RESOLUTIONS, expandColor, quantizeColor, quantizeDepth } from './chunk-lod';
import { F_FOLIAGE, F_SNOW, F_VOID, F_WATER, NO_DATA } from '../flags';

/** Maximum length of a string dynamic property. */
export const MAX_PROPERTY_CHARS = 32767;
/** Chunks per region side (a region is 8×8 chunks). */
export const REGION_CHUNKS = 8;

const MAGIC = 'L1';
const HEIGHT_OFFSET = 64;
const CODE_NO_DATA = 511;
const CODE_VOID = 510;
const MAX_HEIGHT_CODE = 509;

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

const B64_CODES = new Uint8Array(64);
for (let i = 0; i < B64.length; i++) B64_CODES[i] = B64.charCodeAt(i);
const PAD = 61; // '='

function toBase64(bytes: Uint8Array): string {
  // Character codes first, then strings in large pieces: per-character concatenation is slow in QuickJS.
  const codes = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    codes[o++] = B64_CODES[(v >> 18) & 63];
    codes[o++] = B64_CODES[(v >> 12) & 63];
    codes[o++] = B64_CODES[(v >> 6) & 63];
    codes[o++] = B64_CODES[v & 63];
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const v = (bytes[i] << 16) | (rest === 2 ? bytes[i + 1] << 8 : 0);
    codes[o++] = B64_CODES[(v >> 18) & 63];
    codes[o++] = B64_CODES[(v >> 12) & 63];
    codes[o++] = rest === 2 ? B64_CODES[(v >> 6) & 63] : PAD;
    codes[o++] = PAD;
  }
  let out = '';
  for (let k = 0; k < codes.length; k += 4096) {
    out += String.fromCharCode.apply(null, codes.subarray(k, k + 4096) as unknown as number[]);
  }
  return out;
}

function fromBase64(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new CodecError('bad base64 length');
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      if (ch === 61 /* = */) {
        v <<= 6;
        continue;
      }
      const d = ch < 128 ? B64_INDEX[ch] : -1;
      if (d < 0) throw new CodecError('bad base64 character');
      v = (v << 6) | d;
    }
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}

function packSample(h: number, c: number, f: number, d: number): number {
  let code: number;
  if (h === NO_DATA) code = f & F_VOID ? CODE_VOID : CODE_NO_DATA;
  else code = Math.max(0, Math.min(MAX_HEIGHT_CODE, h + HEIGHT_OFFSET));
  const flags3 = (f & F_WATER ? 1 : 0) | (f & F_FOLIAGE ? 2 : 0) | (f & F_SNOW ? 4 : 0);
  const color = h === NO_DATA ? 0 : quantizeColor(c);
  const depth = f & F_WATER ? quantizeDepth(d) : 0;
  return (code | (color << 9) | (flags3 << 25) | (depth << 28)) >>> 0;
}

/** Bytes used by one chunk at the given resolution. */
export function chunkBytes(res: number): number {
  const n = 16 / res;
  return n * n * 4;
}

/**
 * Encodes up to 64 chunks of one region (index = localX + localZ * 8) into a dynamic-property string:
 * `L1|<res>|<16 hex chars presence bitmap>|<base64 payload>`.
 * Chunks whose resolution differs from `res` are skipped.
 */
export function encodeRegion(chunks: ReadonlyArray<ChunkLod | undefined>, res: number): string {
  let lo = 0;
  let hi = 0;
  const present: ChunkLod[] = [];
  for (let i = 0; i < REGION_CHUNKS * REGION_CHUNKS; i++) {
    const c = chunks[i];
    if (!c || c.res !== res) continue;
    if (i < 32) lo |= 1 << i;
    else hi |= 1 << (i - 32);
    present.push(c);
  }
  const per = chunkBytes(res);
  const bytes = new Uint8Array(present.length * per);
  let o = 0;
  for (const c of present) {
    const b = c.base;
    for (let k = 0; k < b.height.length; k++) {
      const v = packSample(b.height[k], b.color[k], b.flags[k], b.depth[k]);
      bytes[o++] = v & 255;
      bytes[o++] = (v >>> 8) & 255;
      bytes[o++] = (v >>> 16) & 255;
      bytes[o++] = (v >>> 24) & 255;
    }
  }
  const hex = (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
  const out = `${MAGIC}|${res}|${hex}|${toBase64(bytes)}`;
  if (out.length > MAX_PROPERTY_CHARS) throw new CodecError(`region too large (${out.length})`);
  return out;
}

/** Decodes a region string; throws {@link CodecError} on any inconsistency. */
export function decodeRegion(s: string): { res: number; chunks: (ChunkLod | undefined)[] } {
  const parts = s.split('|');
  if (parts.length !== 4 || parts[0] !== MAGIC) throw new CodecError('bad region header');
  const res = Number(parts[1]);
  if (!(RESOLUTIONS as readonly number[]).includes(res)) throw new CodecError(`bad resolution ${parts[1]}`);
  if (!/^[0-9a-f]{16}$/.test(parts[2])) throw new CodecError('bad presence bitmap');
  const hi = parseInt(parts[2].slice(0, 8), 16);
  const lo = parseInt(parts[2].slice(8), 16);
  const bytes = fromBase64(parts[3]);
  const per = chunkBytes(res);
  const chunks: (ChunkLod | undefined)[] = new Array(REGION_CHUNKS * REGION_CHUNKS).fill(undefined);
  let o = 0;
  for (let i = 0; i < REGION_CHUNKS * REGION_CHUNKS; i++) {
    const bit = i < 32 ? (lo >>> i) & 1 : (hi >>> (i - 32)) & 1;
    if (!bit) continue;
    if (o + per > bytes.length) throw new CodecError('payload too short');
    const lod = new ChunkLod(res);
    const b = lod.base;
    for (let k = 0; k < b.height.length; k++) {
      const v = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
      o += 4;
      const code = v & 511;
      const flags3 = (v >>> 25) & 7;
      const f = (flags3 & 1 ? F_WATER : 0) | (flags3 & 2 ? F_FOLIAGE : 0) | (flags3 & 4 ? F_SNOW : 0);
      if (code === CODE_NO_DATA || code === CODE_VOID) {
        b.height[k] = NO_DATA;
        b.flags[k] = code === CODE_VOID ? F_VOID : 0;
        continue;
      }
      b.height[k] = code - HEIGHT_OFFSET;
      b.color[k] = expandColor((v >>> 9) & 0xffff);
      b.flags[k] = f;
      b.depth[k] = f & F_WATER ? ((v >>> 28) & 15) * 3 : 0;
    }
    lod.buildMips();
    chunks[i] = lod;
  }
  if (o !== bytes.length) throw new CodecError('payload length mismatch');
  return { res, chunks };
}
