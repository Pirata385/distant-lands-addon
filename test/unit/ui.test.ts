import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsForm, parseModalValues, MENU_PAGES, pagesFor } from '../../src/core/ui-model';
import { parseAction, requiresOperator, ACTIONS } from '../../src/core/command-model';
import { SETTINGS_SCHEMA, Settings, SettingsStorage } from '../../src/core/settings';

const storage: SettingsStorage = { loadWorld: () => undefined, saveWorld: () => {}, loadPlayer: () => undefined, savePlayer: () => {} };

test('settings forms contain a control per setting with current values', () => {
  const s = new Settings(storage);
  s.load();
  s.set('maxDistance', 20);
  const form = buildSettingsForm(['general'], (k) => s.get(k));
  const inputs = form.controls.filter((c) => c.kind !== 'header' && c.kind !== 'label' && c.kind !== 'divider');
  assert.deepEqual(
    inputs.map((c) => c.key),
    SETTINGS_SCHEMA.filter((d) => d.group === 'general').map((d) => d.key),
  );
  const dist = form.controls.find((c) => c.key === 'maxDistance')!;
  assert.equal(dist.kind, 'slider');
  assert.equal(dist.value, 20);
  assert.equal(dist.label, 'dl.setting.maxDistance');
  const style = buildSettingsForm(['display'], (k) => s.get(k)).controls.find((c) => c.key === 'style')!;
  assert.equal(style.kind, 'dropdown');
  assert.deepEqual(style.options, ['dl.opt.style.natural', 'dl.opt.style.vivid', 'dl.opt.style.carto', 'dl.opt.style.elevation', 'dl.opt.style.debug']);
});

test('parses modal values with label slots', () => {
  const form = buildSettingsForm(['general'], (k) => SETTINGS_SCHEMA.find((d) => d.key === k)!.default);
  const inputs = form.controls.filter((c) => c.key);
  // Variant 1: every control (including headers/labels/dividers) has a slot.
  const withSlots = form.controls.map((c) => (c.key ? (c.kind === 'toggle' ? false : 1) : undefined));
  const a = parseModalValues(form, withSlots)!;
  assert.equal(Object.keys(a).length, inputs.length);
  // Variant 2: only inputs have slots.
  const inputsOnly = inputs.map((c) => (c.kind === 'toggle' ? true : 2));
  const b = parseModalValues(form, inputsOnly)!;
  assert.equal(b.enabled, true);
  assert.equal(b.maxDistance, 2);
  // Anything else is rejected.
  assert.equal(parseModalValues(form, [1, 2]), undefined);
  assert.equal(parseModalValues(form, undefined), undefined);
});

test('menu pages for non-operators only include personal pages', () => {
  const op = pagesFor(true).map((p) => p.id);
  const user = pagesFor(false).map((p) => p.id);
  assert.ok(op.length > user.length);
  for (const id of user) assert.ok(MENU_PAGES.find((p) => p.id === id)!.everyone, id);
  assert.ok(user.includes('mine') && user.includes('diagnostics'));
  assert.ok(!user.includes('generation'));
});

test('command arguments are parsed from enums, numbers and script events', () => {
  assert.deepEqual(parseAction(undefined, undefined), { action: 'menu', value: undefined });
  assert.deepEqual(parseAction('pregen', 16), { action: 'pregen', value: 16 });
  assert.deepEqual(parseAction('PREGEN', undefined), { action: 'pregen', value: undefined });
  assert.deepEqual(parseAction('nope', 1), undefined);
  assert.deepEqual(parseAction('dl:pregen', '24'), { action: 'pregen', value: 24 });
  assert.deepEqual(parseAction('dl:menu', ''), { action: 'menu', value: undefined });
  assert.deepEqual(parseAction('dl:set', 'maxDistance=18'), { action: 'set', value: undefined, arg: 'maxDistance=18' });
  assert.ok(ACTIONS.includes('selftest'));
});

test('world-changing actions require operator permission', () => {
  for (const a of ['pregen', 'clear', 'preset', 'reset', 'set']) assert.equal(requiresOperator(a), true, a);
  for (const a of ['menu', 'stats', 'toggle', 'hud', 'selftest']) assert.equal(requiresOperator(a), false, a);
});
