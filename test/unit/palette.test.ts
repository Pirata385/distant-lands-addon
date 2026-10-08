import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseColor,
  applyTint,
  rgb,
  unpack,
  isDecoration,
  isFoliage,
  isGroundCover,
  EXPIRE_BLOCKS,
  styleColor,
  STYLE_NATURAL,
  STYLE_VIVID,
  STYLE_ELEVATION,
  STYLE_DEBUG,
  scale,
  mix,
} from '../../src/core/palette';

test('sand is yellowish and stone is neutral grey', () => {
  const sand = unpack(baseColor('minecraft:sand')!);
  assert.ok(sand.r > sand.b + 40 && sand.g > sand.b, `sand=${JSON.stringify(sand)}`);
  const stone = unpack(baseColor('minecraft:stone')!);
  assert.ok(Math.abs(stone.r - stone.g) < 12 && Math.abs(stone.g - stone.b) < 12, `stone=${JSON.stringify(stone)}`);
  assert.ok(stone.r > 90 && stone.r < 150);
});

test('grass block top is a near-grey texture that is tinted at runtime', () => {
  const g = unpack(baseColor('minecraft:grass_block')!);
  assert.ok(Math.abs(g.r - g.g) < 25 && Math.abs(g.g - g.b) < 25, `grass=${JSON.stringify(g)}`);
});

test('renamed block ids resolve through aliases', () => {
  assert.notEqual(baseColor('minecraft:sugar_cane'), undefined);
  assert.notEqual(baseColor('minecraft:hardened_clay'), undefined);
  assert.notEqual(baseColor('minecraft:water'), undefined);
});

test('unknown block ids have no palette entry', () => {
  assert.equal(baseColor('minecraft:definitely_not_a_block'), undefined);
  assert.equal(baseColor('custom:thing'), undefined);
});

test('applyTint multiplies by the tinted/base map colour ratio', () => {
  const out = unpack(applyTint(rgb(128, 128, 128), { red: 0.5, green: 0.7, blue: 0.2 }, { red: 0.5, green: 0.5, blue: 0.5 }));
  assert.deepEqual(out, { r: 128, g: 179, b: 51 });
});

test('applyTint clamps and ignores zero base channels', () => {
  const out = unpack(applyTint(rgb(200, 200, 200), { red: 1, green: 0.9, blue: 0.3 }, { red: 0.25, green: 0, blue: 0.3 }));
  assert.equal(out.r, 255);
  assert.equal(out.g, 200);
  assert.equal(out.b, 200);
});

test('decorations are skipped while terrain blocks are not', () => {
  for (const id of ['short_grass', 'tall_grass', 'poppy', 'oak_sapling', 'white_carpet', 'torch', 'rail', 'wheat', 'red_mushroom', 'pink_petals', 'fern']) {
    assert.equal(isDecoration(`minecraft:${id}`), true, id);
  }
  for (const id of ['grass_block', 'oak_leaves', 'stone', 'water', 'snow_layer', 'red_mushroom_block', 'sand']) {
    assert.equal(isDecoration(`minecraft:${id}`), false, id);
  }
});

test('foliage covers leaves of every tree type', () => {
  for (const id of ['oak_leaves', 'spruce_leaves', 'azalea_leaves', 'azalea_leaves_flowered', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves']) {
    assert.equal(isFoliage(`minecraft:${id}`), true, id);
  }
  assert.equal(isFoliage('minecraft:grass_block'), false);
});

test('ground cover (for Ground vegetation mode) includes logs and leaves', () => {
  assert.equal(isGroundCover('minecraft:oak_log'), true);
  assert.equal(isGroundCover('minecraft:birch_leaves'), true);
  assert.equal(isGroundCover('minecraft:dirt'), false);
});

test('self-cull block list is namespaced, unique and covers common surfaces', () => {
  const set = new Set(EXPIRE_BLOCKS);
  assert.equal(set.size, EXPIRE_BLOCKS.length);
  for (const id of EXPIRE_BLOCKS) assert.match(id, /^minecraft:[a-z0-9_]+$/);
  for (const id of ['grass_block', 'water', 'stone', 'oak_leaves', 'sand', 'dirt', 'snow', 'deepslate', 'sandstone', 'ice']) {
    assert.ok(set.has(`minecraft:${id}`), id);
  }
  assert.ok(!set.has('minecraft:air'));
});

test('self-cull list stays short because the client checks it per particle', () => {
  assert.ok(EXPIRE_BLOCKS.length <= 128, `length ${EXPIRE_BLOCKS.length}`);
  assert.ok(EXPIRE_BLOCKS.includes('minecraft:orange_terracotta'), 'badlands terracotta is natural terrain');
  assert.ok(!EXPIRE_BLOCKS.includes('minecraft:oak_stairs'), 'building blocks are not listed');
  for (const log of ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']) {
    assert.ok(EXPIRE_BLOCKS.includes(`minecraft:${log}`), `${log}: walls inside tree trunks must self-cull`);
  }
});

test('colour helpers stay within byte range', () => {
  assert.deepEqual(unpack(scale(rgb(200, 100, 50), 2)), { r: 255, g: 200, b: 100 });
  assert.deepEqual(unpack(mix(rgb(0, 0, 0), rgb(255, 255, 255), 0.5)), { r: 128, g: 128, b: 128 });
});

test('styles keep colours valid and change appearance', () => {
  const c = rgb(90, 140, 60);
  const natural = styleColor(STYLE_NATURAL, c, 70, 0, 0);
  assert.equal(natural, c);
  const vivid = unpack(styleColor(STYLE_VIVID, c, 70, 0, 0));
  assert.ok(vivid.g - vivid.b > 140 - 60, 'vivid increases saturation');
  const lowElev = styleColor(STYLE_ELEVATION, c, 64, 0, 0);
  const highElev = styleColor(STYLE_ELEVATION, c, 200, 0, 0);
  assert.notEqual(lowElev, highElev);
  const dbg0 = styleColor(STYLE_DEBUG, c, 70, 0, 0);
  const dbg2 = styleColor(STYLE_DEBUG, c, 70, 0, 2);
  assert.notEqual(dbg0, dbg2);
  for (const v of [lowElev, highElev, dbg0, dbg2]) assert.ok(v >= 0 && v <= 0xffffff);
});
