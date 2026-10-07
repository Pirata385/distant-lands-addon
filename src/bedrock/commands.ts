/** `/dl:horizon` custom command and `/scriptevent dl:<action>` handling. */
import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandRegistry,
  CustomCommandStatus,
  Entity,
  Player,
  RawMessage,
  system,
} from '@minecraft/server';
import { ACTIONS, ParsedAction, parseAction, requiresOperator } from '../core/command-model';
import { defByKey } from '../core/settings';
import { PRESET_NAMES } from '../core/ui-model';
import { openMenu, statsText, UiContext } from './ui';

export const COMMAND_NAME = 'dl:horizon';
export const ACTION_ENUM = 'dl:action';

export type ActionHandler = (player: Player | undefined, action: string | undefined, value: number | string | undefined) => void;

export function registerCommands(registry: CustomCommandRegistry, handler: ActionHandler): void {
  registry.registerEnum(ACTION_ENUM, [...ACTIONS]);
  registry.registerCommand(
    {
      name: COMMAND_NAME,
      description: 'Distant Lands: open settings or run an action (menu, stats, toggle, hud, pregen, clear, selftest, preset, reset)',
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [
        { name: ACTION_ENUM, type: CustomCommandParamType.Enum },
        { name: 'value', type: CustomCommandParamType.Integer },
      ],
    },
    (origin, action?: string, value?: number) => {
      const source: Entity | undefined = origin.initiator ?? origin.sourceEntity;
      const player = source instanceof Player ? source : undefined;
      // Command callbacks run in restricted mode: act on the next tick.
      system.run(() => handler(player, action, value));
      return { status: CustomCommandStatus.Success };
    },
  );
}

function tr(key: string, args?: Array<string | number>): RawMessage {
  return args ? { translate: key, with: args.map(String) } : { translate: key };
}

function parseSettingValue(raw: string): number | boolean | undefined {
  if (raw === 'true' || raw === 'on') return true;
  if (raw === 'false' || raw === 'off') return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Runs an action. `player` is undefined for console/command-block sources, which count as operators. */
export function runAction(ctx: UiContext, player: Player | undefined, parsed: ParsedAction): void {
  const app = ctx.app;
  const reply = (m: RawMessage | string) => (player ? player.sendMessage(m) : console.warn(typeof m === 'string' ? m : m.translate ?? ''));
  const operator = !player || ctx.host.wrapPlayer(player).isOperator();
  if (requiresOperator(parsed.action) && !operator) {
    reply(tr('dl.msg.op_only'));
    return;
  }
  const needsPlayer = ['menu', 'toggle', 'hud', 'selftest', 'pregen', 'stats'].includes(parsed.action);
  if (needsPlayer && !player) {
    reply('Distant Lands: this action needs a player.');
    return;
  }
  switch (parsed.action) {
    case 'menu':
      void openMenu(ctx, player!);
      return;
    case 'stats':
      reply(statsText(ctx, player!.id));
      return;
    case 'toggle':
      reply(tr(app.toggle(player!.id) ? 'dl.msg.enabled' : 'dl.msg.disabled'));
      return;
    case 'hud': {
      const on = !(app.settings.playerValue(player!.id, 'pHud') as boolean);
      app.settings.setPlayer(player!.id, 'pHud', on);
      if (!on) player!.onScreenDisplay.setActionBar('');
      return;
    }
    case 'pregen': {
      const radius = Math.round(parsed.value ?? app.settings.num('maxDistance'));
      reply(tr(app.pregen(player!.id, radius) ? 'dl.msg.pregen' : 'dl.msg.pregen_failed', [radius]));
      return;
    }
    case 'clear':
      app.clearCache();
      reply(tr('dl.msg.cleared'));
      return;
    case 'selftest':
      for (const line of app.selfTest(player!.id, ctx.capabilities())) reply(`§7[Distant Lands]§r ${line}`);
      reply(tr('dl.msg.selftest'));
      return;
    case 'preset': {
      const name = PRESET_NAMES[Math.max(0, Math.min(PRESET_NAMES.length - 1, Math.round(parsed.value ?? 2)))];
      app.settings.applyPreset(name);
      reply(tr('dl.msg.preset', [name]));
      return;
    }
    case 'reset':
      app.settings.resetWorld();
      reply(tr('dl.msg.reset'));
      return;
    case 'set': {
      const m = /^([A-Za-z]+)\s*=\s*(\S+)$/.exec(parsed.arg ?? '');
      const value = m ? parseSettingValue(m[2]) : undefined;
      let ok = false;
      if (m && value !== undefined) {
        try {
          if (defByKey(m[1]).scope === 'world') {
            app.settings.set(m[1], value);
            ok = true;
          }
        } catch {
          ok = false;
        }
      }
      reply(ok ? tr('dl.msg.set', [m![1], String(app.settings.get(m![1]))]) : tr('dl.msg.set_usage'));
      return;
    }
  }
}

/** Handles `/dl:horizon` and `/scriptevent dl:*` invocations. */
export function handleAction(ctx: UiContext, player: Player | undefined, action: string | undefined, value: number | string | undefined): void {
  const parsed = parseAction(action, value);
  if (!parsed) {
    const msg = tr('dl.msg.usage', [ACTIONS.join(', ')]);
    if (player) player.sendMessage(msg);
    return;
  }
  runAction(ctx, player, parsed);
}
