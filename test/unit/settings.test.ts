import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_SCHEMA, Settings, validateValue, PRESETS, defByKey, SettingsStorage } from '../../src/core/settings';

class MemStorage implements SettingsStorage {
  world: string | undefined;
  players = new Map<string, string>();
  loadWorld() {
    return this.world;
  }
  saveWorld(json: string) {
    this.world = json;
  }
  loadPlayer(id: string) {
    return this.players.get(id);
  }
  savePlayer(id: string, json: string) {
    this.players.set(id, json);
  }
}

test('every default is valid for its definition', () => {
  const keys = new Set<string>();
  for (const def of SETTINGS_SCHEMA) {
    assert.ok(!keys.has(def.key), `duplicate ${def.key}`);
    keys.add(def.key);
    assert.deepEqual(validateValue(def, def.default), def.default, def.key);
    if (def.type === 'enum') assert.ok(def.options && def.options.length > 1, def.key);
    if (def.type === 'int') assert.ok(def.min! <= (def.default as number) && (def.default as number) <= def.max!, def.key);
  }
});

test('values are clamped, rounded to step and type-coerced', () => {
  assert.equal(validateValue(defByKey('maxDistance'), 99), 32);
  assert.equal(validateValue(defByKey('maxDistance'), 3), 8);
  assert.equal(validateValue(defByKey('maxDistance'), 20.6), 21);
  assert.equal(validateValue(defByKey('maxQuads'), 1234), 1000);
  assert.equal(validateValue(defByKey('maxQuads'), 1300), 1500);
  assert.equal(validateValue(defByKey('enabled'), 0), false);
  assert.equal(validateValue(defByKey('style'), 17), defByKey('style').options!.length - 1);
  assert.equal(validateValue(defByKey('style'), 'x'), defByKey('style').default);
});

test('loading drops unknown keys and survives malformed json', () => {
  const st = new MemStorage();
  st.world = JSON.stringify({ maxDistance: 16, bogus: 1, style: 2 });
  const s = new Settings(st);
  s.load();
  assert.equal(s.get('maxDistance'), 16);
  assert.equal(s.get('style'), 2);
  assert.equal((s.world as Record<string, unknown>).bogus, undefined);
  st.world = '{not json';
  const s2 = new Settings(st);
  s2.load();
  assert.equal(s2.get('maxDistance'), defByKey('maxDistance').default);
});

test('player distance never exceeds the world maximum or 32 chunks', () => {
  const st = new MemStorage();
  const s = new Settings(st);
  s.load();
  s.set('maxDistance', 20);
  s.setPlayer('p1', 'pDistance', 32);
  assert.equal(s.effective('p1').distance, 20);
  s.setPlayer('p1', 'pDistance', 12);
  assert.equal(s.effective('p1').distance, 12);
  s.set('maxDistance', 64);
  assert.equal(s.get('maxDistance'), 32);
});

test('effective settings combine world and player layers', () => {
  const s = new Settings(new MemStorage());
  s.load();
  const e = s.effective('p');
  assert.equal(e.enabled, true);
  assert.equal(e.res, 4);
  assert.equal(e.quality, 12, 'medium quality factor');
  s.setPlayer('p', 'pQuality', 4); // ultra
  assert.equal(s.effective('p').quality, 22);
  s.set('quality', 4); // custom
  s.set('qualityFactor', 9);
  s.setPlayer('p', 'pQuality', 0); // follow world
  assert.equal(s.effective('p').quality, 9);
  s.setPlayer('p', 'pQuads', 2000);
  assert.equal(s.effective('p').maxQuads, 2000);
  s.setPlayer('p', 'pEnabled', false);
  assert.equal(s.effective('p').enabled, false);
  assert.equal(s.effective('other').enabled, true);
});

test('presets apply valid values', () => {
  const s = new Settings(new MemStorage());
  s.load();
  for (const name of Object.keys(PRESETS)) {
    s.applyPreset(name);
    for (const def of SETTINGS_SCHEMA) {
      if (def.scope !== 'world') continue;
      assert.deepEqual(validateValue(def, s.get(def.key)), s.get(def.key), `${name}.${def.key}`);
    }
  }
  s.applyPreset('potato');
  assert.ok((s.get('maxQuads') as number) < 4000);
  s.applyPreset('ultra');
  assert.equal(s.get('maxDistance'), 32);
});

test('settings persist through storage and bump the version only on change', () => {
  const st = new MemStorage();
  const s = new Settings(st);
  s.load();
  const v0 = s.version;
  assert.equal(s.set('refreshSeconds', 30), true);
  assert.ok(s.version > v0);
  const v1 = s.version;
  assert.equal(s.set('refreshSeconds', 30), false);
  assert.equal(s.version, v1);
  s.setPlayer('abc', 'pHud', true);
  const s2 = new Settings(st);
  s2.load();
  assert.equal(s2.get('refreshSeconds'), 30);
  assert.equal(s2.playerValue('abc', 'pHud'), true);
});

test('player keys cannot be set on the world layer and vice versa', () => {
  const s = new Settings(new MemStorage());
  s.load();
  assert.throws(() => s.set('pHud', true));
  assert.throws(() => s.setPlayer('p', 'maxDistance', 10));
});

test('resetWorld restores every world default and persists it', () => {
  const st = new MemStorage();
  const s = new Settings(st);
  s.load();
  s.applyPreset('ultra');
  s.set('style', 3);
  s.resetWorld();
  for (const def of SETTINGS_SCHEMA) if (def.scope === 'world') assert.deepEqual(s.get(def.key), def.default, def.key);
  const s2 = new Settings(st);
  s2.load();
  assert.equal(s2.get('maxDistance'), defByKey('maxDistance').default);
});
