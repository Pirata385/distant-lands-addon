import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleChunk, SamplerOptions, VEG_CANOPY, VEG_GROUND } from '../../src/core/sampler';
import { ChunkLod, F_FOLIAGE, F_SNOW, F_VOID, F_WATER, NO_DATA } from '../../src/core/lod/chunk-lod';
import { FakeDimension, Column, SEA_LEVEL } from '../fakes/terrain';
import { baseColor, unpack, applyTint } from '../../src/core/palette';

const OPTS: SamplerOptions = { waterDepth: true, vegetation: VEG_CANOPY };

function run(dim: FakeDimension, cx: number, cz: number, res: number, opts = OPTS): { lod: ChunkLod | null; yields: number } {
  const gen = sampleChunk(dim, cx, cz, res, opts);
  let yields = 0;
  for (;;) {
    const r = gen.next();
    if (r.done) return { lod: r.value, yields };
    yields++;
  }
}

function flat(blocks: (x: number, z: number) => Column['blocks']): FakeDimension {
  return new FakeDimension('minecraft:overworld', 0, (x, z) => ({ blocks: blocks(x, z), ground: 70 }));
}

test('heights are the top surface of the ground and samples sit in cell centres', () => {
  const seen: Array<[number, number]> = [];
  const dim = new FakeDimension('minecraft:overworld', 0, (x, z) => {
    seen.push([x, z]);
    return { blocks: [{ y: 60 + (x & 15), typeId: 'minecraft:stone' }], ground: 60 + (x & 15) };
  });
  const { lod } = run(dim, 2, -1, 4);
  assert.ok(lod);
  const b = lod!.base;
  assert.equal(b.n, 4);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) assert.equal(b.height[i + j * 4], 60 + (i * 4 + 2) + 1);
  assert.ok(seen.every(([x, z]) => x >= 32 && x < 48 && z >= -16 && z < 0));
  assert.equal(lod!.levels.length, 3);
});

test('decorations are looked through', () => {
  const dim = flat(() => [
    { y: 71, typeId: 'minecraft:short_grass' },
    { y: 70, typeId: 'minecraft:grass_block' },
  ]);
  const { lod } = run(dim, 0, 0, 8);
  assert.equal(lod!.base.height[0], 71);
  assert.equal(lod!.base.flags[0] & F_FOLIAGE, 0);
});

test('snow layers keep the ground height and mark snow', () => {
  const dim = flat(() => [
    { y: 71, typeId: 'minecraft:snow_layer' },
    { y: 70, typeId: 'minecraft:grass_block' },
  ]);
  const { lod } = run(dim, 0, 0, 8);
  assert.equal(lod!.base.height[0], 71);
  assert.equal(lod!.base.flags[0] & F_SNOW, F_SNOW);
  const c = unpack(lod!.base.color[0]);
  assert.ok(c.r > 220 && c.g > 220 && c.b > 220, JSON.stringify(c));
});

test('water records surface height, depth and tinted colour', () => {
  const dim = flat(() => {
    const blocks = [];
    for (let y = SEA_LEVEL; y > 50; y--) blocks.push({ y, typeId: 'minecraft:water' });
    blocks.push({ y: 50, typeId: 'minecraft:sand' });
    return blocks;
  });
  const { lod } = run(dim, 0, 0, 8);
  const b = lod!.base;
  assert.equal(b.height[0], SEA_LEVEL + 1);
  assert.equal(b.flags[0] & F_WATER, F_WATER);
  assert.equal(b.depth[0], SEA_LEVEL - 50);
  const c = unpack(b.color[0]);
  assert.ok(c.b > c.r && c.b > c.g, `water should be blue ${JSON.stringify(c)}`);
});

test('water plants reaching the surface are sampled as water, and the depth ray looks through them', () => {
  const dim = flat((x) => {
    if (x < 8) return [{ y: SEA_LEVEL, typeId: 'minecraft:seagrass' }, { y: SEA_LEVEL - 1, typeId: 'minecraft:sand' }];
    const blocks = [];
    for (let y = SEA_LEVEL; y > 54; y--) blocks.push({ y, typeId: 'minecraft:kelp' });
    blocks.push({ y: 54, typeId: 'minecraft:gravel' });
    return blocks;
  });
  const b = run(dim, 0, 0, 8).lod!.base; // samples at x=4 (seagrass) and x=12 (kelp)
  for (const k of [0, 1]) {
    assert.equal(b.height[k], SEA_LEVEL + 1, `sample ${k} at the water surface`);
    assert.equal(b.flags[k] & F_WATER, F_WATER);
  }
  assert.equal(b.depth[0], 1);
  assert.equal(b.depth[1], SEA_LEVEL - 54, 'depth measured through the kelp');
});

test('without depth shading no extra raycast is made', () => {
  const dim = flat(() => [{ y: 62, typeId: 'minecraft:water' }, { y: 61, typeId: 'minecraft:sand' }]);
  const { lod } = run(dim, 0, 0, 8, { waterDepth: false, vegetation: VEG_CANOPY });
  assert.equal(lod!.base.depth[0], 0);
});

test('canopy mode keeps trees, ground mode looks through them', () => {
  const dim = flat(() => [
    { y: 76, typeId: 'minecraft:oak_leaves' },
    { y: 75, typeId: 'minecraft:oak_leaves' },
    { y: 74, typeId: 'minecraft:oak_log' },
    { y: 73, typeId: 'minecraft:oak_log' },
    { y: 72, typeId: 'minecraft:oak_log' },
    { y: 71, typeId: 'minecraft:oak_log' },
    { y: 70, typeId: 'minecraft:grass_block' },
  ]);
  const canopy = run(dim, 0, 0, 8).lod!;
  assert.equal(canopy.base.height[0], 77);
  assert.equal(canopy.base.flags[0] & F_FOLIAGE, F_FOLIAGE);
  const ground = run(dim, 0, 0, 8, { waterDepth: true, vegetation: VEG_GROUND }).lod!;
  assert.equal(ground.base.height[0], 71);
  assert.equal(ground.base.flags[0] & F_FOLIAGE, 0);
});

test('grass colour is the palette colour multiplied by the biome tint', () => {
  const dim = flat(() => [{ y: 70, typeId: 'minecraft:grass_block' }]);
  const { lod } = run(dim, 0, 0, 8);
  const block = dim.blockAt(4, 70, 4);
  const mc = block.mapColor()!;
  assert.equal(lod!.base.color[0], applyTint(baseColor('minecraft:grass_block')!, mc.tinted, mc.base));
});

test('unloaded chunks abort sampling', () => {
  const dim = new FakeDimension();
  dim.loaded = new Set(['1,1']);
  assert.equal(run(dim, 0, 0, 4).lod, null);
  assert.ok(run(dim, 1, 1, 4).lod);
});

test('void columns (The End) are NO_DATA with the void flag', () => {
  const dim = new FakeDimension('minecraft:the_end', 2, () => undefined);
  const { lod } = run(dim, 0, 0, 8);
  assert.equal(lod!.base.height[0], NO_DATA);
  assert.equal(lod!.base.flags[0] & F_VOID, F_VOID);
});

test('sampling yields so the scheduler can slice it', () => {
  const { yields } = run(new FakeDimension(), 0, 0, 2);
  assert.ok(yields >= 4, `yields=${yields}`);
});

test('host errors other than unloaded chunks also abort the chunk', () => {
  const dim = new FakeDimension();
  dim.topmost = () => {
    throw new Error('boom');
  };
  assert.equal(run(dim, 0, 0, 8).lod, null);
});
