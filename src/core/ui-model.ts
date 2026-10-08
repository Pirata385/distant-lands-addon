import { GroupId, SETTINGS_SCHEMA, Value } from './settings';

export type ControlKind = 'header' | 'label' | 'divider' | 'slider' | 'toggle' | 'dropdown';

/** One form control. `label`, `tooltip` and `options` are translation keys. */
export interface Control {
  kind: ControlKind;
  key?: string;
  label: string;
  tooltip?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  value?: Value;
}

export interface FormModel {
  title: string;
  controls: Control[];
}

/** Builds a modal form for the given settings groups, filled with current values. */
export function buildSettingsForm(groups: readonly GroupId[], get: (key: string) => Value, title = 'dl.ui.title'): FormModel {
  const controls: Control[] = [];
  for (const g of groups) {
    if (groups.length > 1) controls.push({ kind: 'header', label: `dl.group.${g}` });
    for (const d of SETTINGS_SCHEMA) {
      if (d.group !== g) continue;
      const base = { key: d.key, label: `dl.setting.${d.key}`, tooltip: `dl.tip.${d.key}`, value: get(d.key) };
      if (d.type === 'int') controls.push({ ...base, kind: 'slider', min: d.min, max: d.max, step: d.step ?? 1 });
      else if (d.type === 'bool') controls.push({ ...base, kind: 'toggle' });
      else controls.push({ ...base, kind: 'dropdown', options: d.options!.map((o) => `dl.opt.${d.key}.${o}`) });
    }
  }
  return { title, controls };
}

function isInput(c: Control): boolean {
  return c.kind === 'slider' || c.kind === 'toggle' || c.kind === 'dropdown';
}

/**
 * Maps ModalFormResponse.formValues back to setting keys. Depending on the client, headers/labels/dividers either
 * occupy a slot (undefined) or are omitted, so both layouts are accepted; anything else is rejected.
 */
export function parseModalValues(form: FormModel, values: readonly unknown[] | undefined): Record<string, Value> | undefined {
  if (!values) return undefined;
  const inputs = form.controls.filter(isInput);
  let source: Array<[Control, unknown]>;
  if (values.length === form.controls.length) source = form.controls.map((c, i) => [c, values[i]]);
  else if (values.length === inputs.length) source = inputs.map((c, i) => [c, values[i]]);
  else return undefined;
  const out: Record<string, Value> = {};
  for (const [c, v] of source) {
    if (!isInput(c) || !c.key) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[c.key] = v;
  }
  return out;
}

export interface MenuPage {
  id: string;
  /** Translation key of the button. */
  label: string;
  /** Visible to non-operators. */
  everyone: boolean;
  groups?: GroupId[];
  icon: string;
}

export const MENU_PAGES: readonly MenuPage[] = [
  { id: 'mine', label: 'dl.page.mine', everyone: true, groups: ['player'], icon: 'textures/ui/icon_steve' },
  { id: 'toggle', label: 'dl.page.toggle', everyone: true, icon: 'textures/ui/toggle_on' },
  { id: 'presets', label: 'dl.page.presets', everyone: false, icon: 'textures/ui/icon_recipe_nature' },
  { id: 'general', label: 'dl.page.general', everyone: false, groups: ['general'], icon: 'textures/ui/world_glyph_color_2x' },
  { id: 'generation', label: 'dl.page.generation', everyone: false, groups: ['generation'], icon: 'textures/ui/icon_map' },
  { id: 'performance', label: 'dl.page.performance', everyone: false, groups: ['updates', 'performance'], icon: 'textures/ui/speed_effect' },
  { id: 'display', label: 'dl.page.display', everyone: false, groups: ['display'], icon: 'textures/ui/video_glyph_color_2x' },
  { id: 'cache', label: 'dl.page.cache', everyone: false, groups: ['cache'], icon: 'textures/ui/storageIconColor' },
  { id: 'diagnostics', label: 'dl.page.diagnostics', everyone: true, icon: 'textures/ui/debug_glyph_color' },
];

export function pagesFor(operator: boolean): MenuPage[] {
  return MENU_PAGES.filter((p) => operator || p.everyone);
}

export const PRESET_NAMES = ['potato', 'low', 'medium', 'high', 'ultra'] as const;
