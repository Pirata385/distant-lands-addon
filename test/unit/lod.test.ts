import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkLod, aggregate, CellOut, F_WATER, F_FOLIAGE, F_SNOW, F_VOID, NO_DATA, sameContent } from '../../src/core/lod/chunk-lod';
import { encodeRegion, decodeRegion, CodecError, MAX_PROPERTY_CHARS } from '../../src/core/lod/codec';
import { rgb, unpack } from '../../src/core/palette';

function out(): CellOut {
  return { h: 0, c: 0, f: 0, d: 0 };
}

test('water majority makes a water cell at the highest water level', () => {
  const o = out();
  aggregate([62, 63, 70, 71], [rgb(0, 0, 200), rgb(0, 0, 100), rgb(0, 200, 0), rgb(0, 100, 0)], [F_WATER, F_WATER, 0, 0], [8, 4, 0, 0], 4, o);
  assert.equal(o.h, 63);
  assert.equal(o.f & F_WATER, F_WATER);
  assert.deepEqual(unpack(o.c), { r: 0, g: 0, b: 150 });
  assert.equal(o.d, 6);
});

test('land cells take the second-highest height and the mean colour', () => {
  const o = out();
  aggregate([70, 75, 72, 90], [rgb(100, 0, 0), rgb(0, 100, 0), rgb(0, 0, 100), rgb(100, 100, 100)], [F_FOLIAGE, F_FOLIAGE, F_FOLIAGE, 0], [0, 0, 0, 0], 4, o);
  assert.equal(o.h, 75);
  assert.deepEqual(unpack(o.c), { r: 50, g: 50, b: 50 });
  assert.equal(o.f & F_WATER, 0);
  assert.equal(o.f & F_FOLIAGE, F_FOLIAGE, 'majority foliage');
});

test('missing children are ignored and all-missing yields NO_DATA', () => {
  const o = out();
  aggregate([NO_DATA, 80, NO_DATA, NO_DATA], [0, rgb(10, 20, 30), 0, 0], [0, F_SNOW, 0, 0], [0, 0, 0, 0], 4, o);
  assert.equal(o.h, 80);
  assert.equal(o.f & F_SNOW, F_SNOW);
  aggregate([NO_DATA, NO_DATA, NO_DATA, NO_DATA], [0, 0, 0, 0], [F_VOID, F_VOID, F_VOID, F_VOID], [0, 0, 0, 0], 4, o);
  assert.equal(o.h, NO_DATA);
  assert.equal(o.f & F_VOID, F_VOID);
});

test('chunk lod levels go from the base resolution up to one cell per chunk', () => {
  const lod = new ChunkLod(4);
  assert.deepEqual(lod.levels.map((l) => [l.size, l.n]), [[4, 4], [8, 2], [16, 1]]);
  assert.deepEqual(new ChunkLod(2).levels.map((l) => l.size), [2, 4, 8, 16]);
  assert.deepEqual(new ChunkLod(8).levels.map((l) => l.size), [8, 16]);
  assert.equal(lod.level(8)!.n, 2);
  assert.equal(lod.level(32), undefined);
});

test('buildMips aggregates the base level', () => {
  const lod = new ChunkLod(4);
  const b = lod.levels[0];
  for (let i = 0; i < b.height.length; i++) {
    b.height[i] = 64 + (i % 4);
    b.color[i] = rgb(40, 120, 40);
  }
  lod.buildMips();
  const top = lod.levels[2];
  assert.equal(top.n, 1);
  assert.ok(top.height[0] >= 65 && top.height[0] <= 67);
  assert.deepEqual(unpack(top.color[0]), { r: 40, g: 120, b: 40 });
});

function randomChunk(res: number, seed: number): ChunkLod {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const lod = new ChunkLod(res);
  const b = lod.levels[0];
  for (let i = 0; i < b.height.length; i++) {
    const kind = rnd();
    if (kind < 0.05) {
      b.height[i] = NO_DATA;
      b.flags[i] = F_VOID;
      continue;
    }
    b.height[i] = Math.floor(rnd() * 380) - 60;
    b.color[i] = rgb(rnd() * 255, rnd() * 255, rnd() * 255);
    b.flags[i] = kind < 0.4 ? F_WATER : kind < 0.6 ? F_FOLIAGE : kind < 0.7 ? F_SNOW : 0;
    b.depth[i] = b.flags[i] & F_WATER ? Math.floor(rnd() * 40) : 0;
  }
  lod.buildMips();
  return lod;
}

test('region codec round-trips heights, flags and colours within quantisation', () => {
  for (const res of [2, 4, 8]) {
    const chunks: (ChunkLod | undefined)[] = [];
    for (let i = 0; i < 64; i++) chunks.push(i % 3 === 0 ? undefined : randomChunk(res, i + res));
    const decoded = decodeRegion(encodeRegion(chunks, res));
    assert.equal(decoded.res, res);
    for (let i = 0; i < 64; i++) {
      const a = chunks[i];
      const b = decoded.chunks[i];
      if (!a) {
        assert.equal(b, undefined);
        continue;
      }
      assert.ok(b);
      const la = a.levels[0];
      const lb = b!.levels[0];
      for (let k = 0; k < la.height.length; k++) {
        assert.equal(lb.height[k], la.height[k]);
        assert.equal(lb.flags[k], la.flags[k]);
        if (la.height[k] === NO_DATA) continue;
        const ca = unpack(la.color[k]);
        const cb = unpack(lb.color[k]);
        assert.ok(Math.abs(ca.r - cb.r) <= 4 && Math.abs(ca.g - cb.g) <= 2 && Math.abs(ca.b - cb.b) <= 4);
        assert.ok(Math.abs(la.depth[k] - lb.depth[k]) <= 2);
      }
      assert.ok(sameContent(a, b!), 'decoded chunk has the same content as the source');
    }
  }
});

test('region payload is canonical base64 in every padding case', () => {
  // res 8 chunks are 16 bytes: 1, 2 and 3 chunks cover '==', '=' and no padding.
  for (const count of [1, 2, 3]) {
    const chunks = Array.from({ length: 64 }, (_, i) => (i < count ? randomChunk(8, i + 100) : undefined));
    const s = encodeRegion(chunks, 8);
    const payload = s.split('|')[3];
    const bytes = Buffer.from(payload, 'base64');
    assert.equal(bytes.length, count * 16);
    assert.equal(bytes.toString('base64'), payload);
    const back = decodeRegion(s);
    for (let i = 0; i < count; i++) assert.ok(sameContent(chunks[i]!, back.chunks[i]!));
  }
});

test('corrupt region strings throw CodecError', () => {
  assert.throws(() => decodeRegion('garbage'), CodecError);
  assert.throws(() => decodeRegion('L1|4|0000000000000001|'), CodecError);
  assert.throws(() => decodeRegion('L1|3|0000000000000000|'), CodecError);
});

test('max region at res 2 fits property limit', () => {
  const chunks = Array.from({ length: 64 }, (_, i) => randomChunk(2, i));
  const s = encodeRegion(chunks, 2);
  assert.ok(s.length <= MAX_PROPERTY_CHARS, `length ${s.length}`);
  assert.equal(MAX_PROPERTY_CHARS, 32767);
});

test('sameContent ignores colour quantisation but not height changes', () => {
  const a = randomChunk(4, 7);
  const b = randomChunk(4, 7);
  b.levels[0].color[3] ^= 1;
  assert.ok(sameContent(a, b));
  b.levels[0].height[5] += a.levels[0].height[5] === NO_DATA ? 0 : 1;
  if (a.levels[0].height[5] !== NO_DATA) assert.ok(!sameContent(a, b));
});
