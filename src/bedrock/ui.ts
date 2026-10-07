/** In-game configuration UI (@minecraft/server-ui 2.0.0). Forms are generated from the settings schema. */
import { Player, RawMessage, system } from '@minecraft/server';
import { ActionFormData, FormCancelationReason, MessageFormData, ModalFormData } from '@minecraft/server-ui';
import type { App } from '../core/app';
import { buildSettingsForm, FormModel, MenuPage, pagesFor, parseModalValues, PRESET_NAMES } from '../core/ui-model';
import { GroupId, Value } from '../core/settings';
import type { BedrockHost } from './host';

export interface UiContext {
  app: App;
  host: BedrockHost;
  capabilities: () => Record<string, string | number | boolean>;
}

function tr(key: string, args?: Array<string | number>): RawMessage {
  return args ? { translate: key, with: args.map(String) } : { translate: key };
}

interface Shown {
  canceled: boolean;
  cancelationReason?: FormCancelationReason;
}

/** Shows a form, retrying while the player is busy (chat open right after typing the command). */
async function present<T extends Shown>(player: Player, show: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!player.isValid) return undefined;
    const r = await show();
    if (r.canceled && r.cancelationReason === FormCancelationReason.UserBusy) {
      await system.waitTicks(5);
      continue;
    }
    return r.canceled ? undefined : r;
  }
  return undefined;
}

function isOperator(ctx: UiContext, player: Player): boolean {
  return ctx.host.wrapPlayer(player).isOperator();
}

export async function openMenu(ctx: UiContext, player: Player): Promise<void> {
  const pages = pagesFor(isOperator(ctx, player));
  const st = ctx.app.stats(player.id);
  const enabled = ctx.app.settings.playerValue(player.id, 'pEnabled') as boolean;
  const body: RawMessage = st
    ? tr('dl.ui.status', [
        enabled && ctx.app.settings.flag('enabled') ? '§aON§r' : '§cOFF§r',
        st.distance,
        st.radius,
        st.quads,
        st.cached,
        st.generated,
      ])
    : tr('dl.ui.status_unknown');
  const form = new ActionFormData().title(tr('dl.ui.title')).body(body);
  for (const p of pages) form.button(tr(p.label), p.icon);
  const r = await present(player, () => form.show(player));
  if (!r || r.selection === undefined) return;
  const page = pages[r.selection];
  if (page && (await openPage(ctx, player, page))) await openMenu(ctx, player);
}

/** Returns true when the menu should be shown again afterwards. */
async function openPage(ctx: UiContext, player: Player, page: MenuPage): Promise<boolean> {
  const app = ctx.app;
  switch (page.id) {
    case 'toggle': {
      const on = app.toggle(player.id);
      player.sendMessage(tr(on ? 'dl.msg.enabled' : 'dl.msg.disabled'));
      return false;
    }
    case 'presets':
      return openPresets(ctx, player);
    case 'diagnostics':
      return openDiagnostics(ctx, player);
    case 'cache':
      return openCache(ctx, player);
    case 'mine':
      return editSettings(ctx, player, page.groups!, true);
    default:
      return editSettings(ctx, player, page.groups!, false);
  }
}

function buildModal(model: FormModel): ModalFormData {
  const f = new ModalFormData().title(tr(model.title));
  for (const c of model.controls) {
    const tooltip = c.tooltip ? tr(c.tooltip) : undefined;
    switch (c.kind) {
      case 'header':
        f.header(tr(c.label));
        break;
      case 'label':
        f.label(tr(c.label));
        break;
      case 'divider':
        f.divider();
        break;
      case 'slider':
        f.slider(tr(c.label), c.min!, c.max!, { valueStep: c.step, defaultValue: c.value as number, tooltip });
        break;
      case 'toggle':
        f.toggle(tr(c.label), { defaultValue: c.value as boolean, tooltip });
        break;
      case 'dropdown':
        f.dropdown(
          tr(c.label),
          c.options!.map((o) => tr(o)),
          { defaultValueIndex: c.value as number, tooltip },
        );
        break;
    }
  }
  f.submitButton(tr('dl.ui.save'));
  return f;
}

async function editSettings(ctx: UiContext, player: Player, groups: GroupId[], personal: boolean): Promise<boolean> {
  const app = ctx.app;
  const get = (k: string): Value => (personal ? app.settings.playerValue(player.id, k) : app.settings.get(k));
  const model = buildSettingsForm(groups, get, personal ? 'dl.page.mine' : 'dl.ui.title');
  const r = await present(player, () => buildModal(model).show(player));
  if (!r) return true;
  const values = parseModalValues(model, r.formValues);
  if (!values) {
    player.sendMessage(tr('dl.msg.form_error'));
    return true;
  }
  if (!personal && !isOperator(ctx, player)) {
    player.sendMessage(tr('dl.msg.op_only'));
    return false;
  }
  let changed = 0;
  for (const [k, v] of Object.entries(values)) {
    if (personal ? app.settings.setPlayer(player.id, k, v) : app.settings.set(k, v)) changed++;
  }
  player.sendMessage(tr('dl.msg.saved', [changed]));
  return true;
}

async function openPresets(ctx: UiContext, player: Player): Promise<boolean> {
  const f = new ActionFormData().title(tr('dl.page.presets')).body(tr('dl.ui.presets_body'));
  for (const name of PRESET_NAMES) f.button(tr(`dl.preset.${name}`));
  const r = await present(player, () => f.show(player));
  if (!r || r.selection === undefined) return true;
  if (!isOperator(ctx, player)) return false;
  const name = PRESET_NAMES[r.selection];
  ctx.app.settings.applyPreset(name);
  player.sendMessage(tr('dl.msg.preset', [name]));
  return true;
}

async function openCache(ctx: UiContext, player: Player): Promise<boolean> {
  const f = new ActionFormData()
    .title(tr('dl.page.cache'))
    .body(tr('dl.ui.cache_body', [ctx.app.store.stats().persistedRegions, Math.round(ctx.app.store.stats().bytes / 1024)]))
    .button(tr('dl.ui.cache_settings'), 'textures/ui/settings_glyph_color_2x')
    .button(tr('dl.ui.pregen'), 'textures/ui/icon_map')
    .button(tr('dl.ui.clear'), 'textures/ui/icon_trash');
  const r = await present(player, () => f.show(player));
  if (!r || r.selection === undefined) return true;
  if (r.selection === 0) return editSettings(ctx, player, ['cache'], false);
  if (r.selection === 1) {
    const ok = ctx.app.pregen(player.id, ctx.app.settings.num('maxDistance'));
    player.sendMessage(tr(ok ? 'dl.msg.pregen' : 'dl.msg.pregen_failed', [ctx.app.settings.num('maxDistance')]));
    return true;
  }
  const confirm = new MessageFormData()
    .title(tr('dl.ui.clear'))
    .body(tr('dl.ui.clear_confirm'))
    .button1(tr('dl.ui.cancel'))
    .button2(tr('dl.ui.clear'));
  const c = await present(player, () => confirm.show(player));
  if (c && c.selection === 1) {
    ctx.app.clearCache();
    player.sendMessage(tr('dl.msg.cleared'));
  }
  return true;
}

async function openDiagnostics(ctx: UiContext, player: Player): Promise<boolean> {
  const hud = ctx.app.settings.playerValue(player.id, 'pHud') as boolean;
  const f = new ActionFormData()
    .title(tr('dl.page.diagnostics'))
    .body(statsText(ctx, player.id))
    .button(tr(hud ? 'dl.ui.hud_off' : 'dl.ui.hud_on'), 'textures/ui/icon_setting')
    .button(tr('dl.ui.selftest'), 'textures/ui/spyglass_flat');
  const r = await present(player, () => f.show(player));
  if (!r || r.selection === undefined) return true;
  if (r.selection === 0) {
    ctx.app.settings.setPlayer(player.id, 'pHud', !hud);
    return true;
  }
  for (const line of ctx.app.selfTest(player.id, ctx.capabilities())) player.sendMessage(`§7[Distant Lands]§r ${line}`);
  player.sendMessage(tr('dl.msg.selftest'));
  return false;
}

export function statsText(ctx: UiContext, id: string): string {
  const s = ctx.app.stats(id);
  if (!s) return '-';
  return [
    `LOD quads: ${s.quads}  tiles: ${s.tiles}  spawns/s: ${s.spawnRate}`,
    `Radius: vanilla ${s.radius} → LOD ${s.distance} chunks  quality ${s.quality}`,
    `Cached chunks: ${s.cached}  generated: ${s.generated}  captured: ${s.sampled}`,
    `Storage: ${Math.round(s.storage / 1024)} KB  queue: ${s.genQueue}  refresh: ${Math.round(s.refresh)} s`,
    `Script: ${s.ms.toFixed(2)} ms/tick  errors: ${s.errors}${s.paused ? '  (paused underground)' : ''}`,
  ].join('\n');
}
