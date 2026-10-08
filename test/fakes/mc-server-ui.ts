/** Fake `@minecraft/server-ui` 2.0.0: records shown forms and answers them from a scripted queue. */

export enum FormCancelationReason {
  UserBusy = 'UserBusy',
  UserClosed = 'UserClosed',
}

export interface ShownForm {
  type: 'action' | 'modal' | 'message';
  title: unknown;
  body?: unknown;
  buttons: unknown[];
  controls: Array<{ kind: string; label: unknown; options?: unknown; extra?: unknown }>;
  player: unknown;
}

/** A scripted answer: selection for action/message forms, formValues for modal forms, or a cancel. */
export type Answer =
  | { selection: number }
  | { formValues: unknown[] }
  | { canceled: true; reason?: FormCancelationReason }
  | ((form: ShownForm) => { selection?: number; formValues?: unknown[]; canceled?: boolean; reason?: FormCancelationReason });

export const ui = {
  shown: [] as ShownForm[],
  answers: [] as Answer[],
  reset() {
    this.shown = [];
    this.answers = [];
  },
};

function answer(form: ShownForm): Promise<any> {
  ui.shown.push(form);
  const a = ui.answers.shift();
  const r = typeof a === 'function' ? a(form) : a;
  if (!r || ('canceled' in r && r.canceled)) {
    const reason = r && 'reason' in r ? r.reason : FormCancelationReason.UserClosed;
    return Promise.resolve({ canceled: true, cancelationReason: reason ?? FormCancelationReason.UserClosed });
  }
  return Promise.resolve({ canceled: false, ...r });
}

export class ActionFormData {
  private f: ShownForm = { type: 'action', title: '', buttons: [], controls: [], player: undefined };
  title(t: unknown) {
    this.f.title = t;
    return this;
  }
  body(b: unknown) {
    this.f.body = b;
    return this;
  }
  button(text: unknown, icon?: string) {
    this.f.buttons.push({ text, icon });
    return this;
  }
  header(t: unknown) {
    this.f.controls.push({ kind: 'header', label: t });
    return this;
  }
  label(t: unknown) {
    this.f.controls.push({ kind: 'label', label: t });
    return this;
  }
  divider() {
    this.f.controls.push({ kind: 'divider', label: '' });
    return this;
  }
  show(player: unknown) {
    return answer({ ...this.f, buttons: [...this.f.buttons], player });
  }
}

export class MessageFormData {
  private f: ShownForm = { type: 'message', title: '', buttons: [], controls: [], player: undefined };
  title(t: unknown) {
    this.f.title = t;
    return this;
  }
  body(b: unknown) {
    this.f.body = b;
    return this;
  }
  button1(t: unknown) {
    this.f.buttons[0] = t;
    return this;
  }
  button2(t: unknown) {
    this.f.buttons[1] = t;
    return this;
  }
  show(player: unknown) {
    return answer({ ...this.f, player });
  }
}

export class ModalFormData {
  private f: ShownForm = { type: 'modal', title: '', buttons: [], controls: [], player: undefined };
  title(t: unknown) {
    this.f.title = t;
    return this;
  }
  header(t: unknown) {
    this.f.controls.push({ kind: 'header', label: t });
    return this;
  }
  label(t: unknown) {
    this.f.controls.push({ kind: 'label', label: t });
    return this;
  }
  divider() {
    this.f.controls.push({ kind: 'divider', label: '' });
    return this;
  }
  slider(label: unknown, min: number, max: number, opts?: unknown) {
    if (!(min < max)) throw new Error('slider range');
    this.f.controls.push({ kind: 'slider', label, extra: { min, max, ...(opts as object) } });
    return this;
  }
  toggle(label: unknown, opts?: unknown) {
    this.f.controls.push({ kind: 'toggle', label, extra: opts });
    return this;
  }
  dropdown(label: unknown, options: unknown[], opts?: unknown) {
    this.f.controls.push({ kind: 'dropdown', label, options, extra: opts });
    return this;
  }
  textField(label: unknown, placeholder: unknown, opts?: unknown) {
    this.f.controls.push({ kind: 'text', label, extra: { placeholder, ...(opts as object) } });
    return this;
  }
  submitButton(t: unknown) {
    this.f.buttons = [t];
    return this;
  }
  show(player: unknown) {
    return answer({ ...this.f, controls: [...this.f.controls], player });
  }
}

export class UIManager {
  closeAllForms() {}
}
export const uiManager = new UIManager();
