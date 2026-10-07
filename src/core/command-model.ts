/** Actions available through `/dl:horizon <action> [value]` and `/scriptevent dl:<action> [value]`. */
export const ACTIONS = ['menu', 'stats', 'toggle', 'hud', 'pregen', 'clear', 'selftest', 'preset', 'reset', 'set'] as const;
export type Action = (typeof ACTIONS)[number];

const OPERATOR_ACTIONS = new Set<string>(['pregen', 'clear', 'preset', 'reset', 'set']);

export interface ParsedAction {
  action: Action;
  value: number | undefined;
  /** Free-form argument (only for `set key=value`). */
  arg?: string;
}

/** Parses an action name (enum value or script event id such as `dl:pregen`) and its optional value. */
export function parseAction(raw: string | undefined, value: number | string | undefined): ParsedAction | undefined {
  const name = (raw ?? 'menu').trim().toLowerCase().replace(/^dl:/, '') || 'menu';
  if (!(ACTIONS as readonly string[]).includes(name)) return undefined;
  const action = name as Action;
  if (typeof value === 'number') return { action, value: Number.isFinite(value) ? value : undefined };
  const text = (value ?? '').trim();
  if (text === '') return { action, value: undefined };
  const num = Number(text);
  if (Number.isFinite(num)) return { action, value: num };
  return { action, value: undefined, arg: text };
}

export function requiresOperator(action: string): boolean {
  return OPERATOR_ACTIONS.has(action);
}
