/** Bedrock runs add-on scripts in QuickJS, not V8: the shipped bundle must parse and run its top-level code there. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
// @ts-ignore - plain ESM build script
import { build } from '../../scripts/build.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

/** Minimal module stubs: enough for the bundle's top-level code (subscriptions and timers). */
const SERVER_STUB = `
const signal = () => ({ subscribe(cb) { return cb; }, unsubscribe() {} });
export const system = {
  beforeEvents: { startup: signal(), shutdown: signal() },
  afterEvents: { scriptEventReceive: signal() },
  run() { return 0; }, runTimeout() { return 0; }, runInterval() { return 0; }, runJob() { return 0; },
  currentTick: 0,
};
export const world = { afterEvents: new Proxy({}, { get: () => signal() }) };
export class Player {}
export class MolangVariableMap { setFloat() {} }
export const PlayerPermissionLevel = { Visitor: 0, Member: 1, Operator: 2, Custom: 3 };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 };
export const CustomCommandParamType = { Enum: 'Enum', Integer: 'Integer' };
export const CustomCommandStatus = { Success: 0, Failure: 1 };
export const TintMethod = { None: 'None' };
`;
const UI_STUB = `
export class ActionFormData {} export class ModalFormData {} export class MessageFormData {}
export const FormCancelationReason = { UserBusy: 'UserBusy', UserClosed: 'UserClosed' };
`;

test('the shipped bundle loads as an ES module in QuickJS', async (t) => {
  const base = join(ROOT, 'test-output');
  mkdirSync(base, { recursive: true });
  const outDir = mkdtempSync(join(base, 'qjs-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const r = await build({ outDir });
  const source = readFileSync(join(r.bpDir, 'scripts', 'main.js'), 'utf8');
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(256 * 1024 * 1024);
  runtime.setModuleLoader((name) => {
    if (name === '@minecraft/server') return SERVER_STUB;
    if (name === '@minecraft/server-ui') return UI_STUB;
    throw new Error(`unexpected import ${name}`);
  });
  const vm = runtime.newContext();
  try {
    const result = vm.evalCode(source, 'main.js', { type: 'module' });
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      assert.fail(`QuickJS rejected the bundle: ${JSON.stringify(err)}`);
    }
    result.value.dispose();
  } finally {
    vm.dispose();
    runtime.dispose();
  }
});
