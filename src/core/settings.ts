/** Hard cap on LOD distance in chunks (requirement). */
export const MAX_LOD_CHUNKS = 32;

export type SettingType = 'int' | 'bool' | 'enum';
export type Scope = 'world' | 'player';
export type GroupId = 'general' | 'generation' | 'updates' | 'performance' | 'cache' | 'display' | 'player';
export type Value = number | boolean;
export type Values = Record<string, Value>;

export interface SettingDef {
  readonly key: string;
  readonly scope: Scope;
  readonly group: GroupId;
  readonly type: SettingType;
  readonly default: Value;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Enum option ids; their labels are `dl.opt.<key>.<id>`. */
  readonly options?: readonly string[];
}

function int(key: string, scope: Scope, group: GroupId, def: number, min: number, max: number, step = 1): SettingDef {
  return { key, scope, group, type: 'int', default: def, min, max, step };
}
function bool(key: string, scope: Scope, group: GroupId, def: boolean): SettingDef {
  return { key, scope, group, type: 'bool', default: def };
}
function choice(key: string, scope: Scope, group: GroupId, def: number, options: readonly string[]): SettingDef {
  return { key, scope, group, type: 'enum', default: def, options };
}

export const QUALITY_OPTIONS = ['low', 'medium', 'high', 'ultra', 'custom'] as const;
export const QUALITY_FACTORS: Record<string, number> = { low: 8, medium: 12, high: 16, ultra: 22 };
export const RES_OPTIONS = ['2', '4', '8'] as const;
export const GEN_MODES = ['off', 'explored', 'generate'] as const;
export const GEN_PRIORITIES = ['nearest', 'view', 'balanced'] as const;
export const STYLE_OPTIONS = ['natural', 'vivid', 'carto', 'elevation', 'debug'] as const;
export const VEGETATION_OPTIONS = ['canopy', 'ground'] as const;
export const FOG_MODES = ['horizon', 'vanilla', 'atmospheric'] as const;
export const PLAYER_QUALITY_OPTIONS = ['world', 'low', 'medium', 'high', 'ultra'] as const;

export const SETTINGS_SCHEMA: readonly SettingDef[] = [
  bool('enabled', 'world', 'general', true),
  int('maxDistance', 'world', 'general', 24, 8, MAX_LOD_CHUNKS),
  choice('quality', 'world', 'general', 1, QUALITY_OPTIONS),
  int('qualityFactor', 'world', 'general', 12, 6, 28),
  choice('sampleRes', 'world', 'general', 1, RES_OPTIONS),
  bool('renderEnd', 'world', 'general', false),

  choice('genMode', 'world', 'generation', 2, GEN_MODES),
  choice('genPriority', 'world', 'generation', 2, GEN_PRIORITIES),
  int('genBatch', 'world', 'generation', 4, 2, 8),
  int('genConcurrency', 'world', 'generation', 1, 1, 3),
  bool('genPauseFlying', 'world', 'generation', true),

  int('refreshSeconds', 'world', 'updates', 15, 8, 60),
  int('resampleMinutes', 'world', 'updates', 10, 1, 60),
  bool('trackBlockChanges', 'world', 'updates', true),

  int('budgetMs', 'world', 'performance', 3, 1, 10),
  int('spawnsPerTick', 'world', 'performance', 60, 10, 250, 5),
  int('maxQuads', 'world', 'performance', 4000, 1000, 16000, 500),
  bool('adaptive', 'world', 'performance', true),
  bool('pauseUnderground', 'world', 'performance', true),

  int('memoryChunks', 'world', 'cache', 8192, 1024, 32768, 1024),
  bool('persist', 'world', 'cache', true),
  int('storageMB', 'world', 'cache', 8, 1, 32),

  choice('style', 'world', 'display', 0, STYLE_OPTIONS),
  int('relief', 'world', 'display', 60, 0, 100, 5),
  int('aerial', 'world', 'display', 35, 0, 100, 5),
  bool('waterDepth', 'world', 'display', true),
  choice('vegetation', 'world', 'display', 0, VEGETATION_OPTIONS),
  bool('transitions', 'world', 'display', true),
  bool('dayNight', 'world', 'display', true),
  choice('fogMode', 'world', 'display', 0, FOG_MODES),

  bool('pEnabled', 'player', 'player', true),
  int('pDistance', 'player', 'player', MAX_LOD_CHUNKS, 8, MAX_LOD_CHUNKS),
  choice('pQuality', 'player', 'player', 0, PLAYER_QUALITY_OPTIONS),
  int('pQuads', 'player', 'player', 16000, 1000, 16000, 500),
  bool('pHud', 'player', 'player', false),
];

const BY_KEY = new Map(SETTINGS_SCHEMA.map((d) => [d.key, d]));

export function defByKey(key: string): SettingDef {
  const d = BY_KEY.get(key);
  if (!d) throw new Error(`unknown setting ${key}`);
  return d;
}

/** Coerces any input to a valid value for the definition. */
export function validateValue(def: SettingDef, value: unknown): Value {
  switch (def.type) {
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      return def.default;
    case 'enum': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return def.default;
      const max = def.options!.length - 1;
      return Math.max(0, Math.min(max, Math.round(value)));
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return def.default;
      const step = def.step ?? 1;
      const min = def.min!;
      const clamped = Math.max(min, Math.min(def.max!, value));
      const stepped = min + Math.round((clamped - min) / step) * step;
      return Math.max(min, Math.min(def.max!, stepped));
    }
  }
}

function defaults(scope: Scope): Values {
  const v: Values = {};
  for (const d of SETTINGS_SCHEMA) if (d.scope === scope) v[d.key] = d.default;
  return v;
}

function parse(scope: Scope, json: string | undefined): Values {
  const v = defaults(scope);
  if (!json) return v;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return v;
  }
  if (!raw || typeof raw !== 'object') return v;
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    const d = BY_KEY.get(k);
    if (d && d.scope === scope) v[k] = validateValue(d, val);
  }
  return v;
}

/** World-level presets. Values not listed keep their current value. */
export const PRESETS: Record<string, Values> = {
  potato: {
    maxDistance: 12, quality: 0, sampleRes: 2, maxQuads: 1500, spawnsPerTick: 30, refreshSeconds: 20, budgetMs: 2,
    genBatch: 2, genConcurrency: 1, memoryChunks: 2048, relief: 40, aerial: 20, transitions: false, waterDepth: false,
  },
  low: {
    maxDistance: 16, quality: 0, sampleRes: 1, maxQuads: 2500, spawnsPerTick: 40, refreshSeconds: 18, budgetMs: 2,
    genBatch: 3, genConcurrency: 1, memoryChunks: 4096, relief: 50, aerial: 30, transitions: true, waterDepth: true,
  },
  medium: {
    maxDistance: 24, quality: 1, sampleRes: 1, maxQuads: 4000, spawnsPerTick: 60, refreshSeconds: 15, budgetMs: 3,
    genBatch: 4, genConcurrency: 1, memoryChunks: 8192, relief: 60, aerial: 35, transitions: true, waterDepth: true,
  },
  high: {
    maxDistance: 28, quality: 2, sampleRes: 1, maxQuads: 7000, spawnsPerTick: 100, refreshSeconds: 15, budgetMs: 4,
    genBatch: 4, genConcurrency: 2, memoryChunks: 12288, relief: 60, aerial: 35, transitions: true, waterDepth: true,
  },
  ultra: {
    maxDistance: 32, quality: 3, sampleRes: 0, maxQuads: 12000, spawnsPerTick: 160, refreshSeconds: 12, budgetMs: 6,
    genBatch: 6, genConcurrency: 3, memoryChunks: 16384, relief: 60, aerial: 35, transitions: true, waterDepth: true,
  },
};

/** Where settings live (world dynamic property / player dynamic property in game). */
export interface SettingsStorage {
  loadWorld(): string | undefined;
  saveWorld(json: string): void;
  loadPlayer(id: string): string | undefined;
  savePlayer(id: string, json: string): void;
}

/** Settings a subsystem needs for one player. */
export interface Effective {
  enabled: boolean;
  distance: number;
  quality: number;
  res: number;
  maxQuads: number;
  hud: boolean;
}

export class Settings {
  world: Values = defaults('world');
  private readonly players = new Map<string, Values>();
  /** Incremented on every effective change (world or player). */
  version = 0;

  constructor(private readonly storage: SettingsStorage) {}

  load(): void {
    this.world = parse('world', this.storage.loadWorld());
    this.players.clear();
    this.version++;
  }

  get(key: string): Value {
    return this.world[key];
  }

  num(key: string): number {
    return this.world[key] as number;
  }

  flag(key: string): boolean {
    return this.world[key] as boolean;
  }

  /** Sets a world setting. Returns true when the stored value changed. */
  set(key: string, value: unknown): boolean {
    const def = defByKey(key);
    if (def.scope !== 'world') throw new Error(`${key} is a player setting`);
    const v = validateValue(def, value);
    if (this.world[key] === v) return false;
    this.world[key] = v;
    this.version++;
    this.storage.saveWorld(JSON.stringify(this.world));
    return true;
  }

  /** Restores all world settings to their defaults. */
  resetWorld(): void {
    this.world = defaults('world');
    this.version++;
    this.storage.saveWorld(JSON.stringify(this.world));
  }

  applyPreset(name: string): void {
    const preset = PRESETS[name];
    if (!preset) throw new Error(`unknown preset ${name}`);
    for (const [k, v] of Object.entries(preset)) this.world[k] = validateValue(defByKey(k), v);
    this.version++;
    this.storage.saveWorld(JSON.stringify(this.world));
  }

  playerValues(id: string): Values {
    let v = this.players.get(id);
    if (!v) {
      v = parse('player', this.storage.loadPlayer(id));
      this.players.set(id, v);
    }
    return v;
  }

  playerValue(id: string, key: string): Value {
    return this.playerValues(id)[key];
  }

  setPlayer(id: string, key: string, value: unknown): boolean {
    const def = defByKey(key);
    if (def.scope !== 'player') throw new Error(`${key} is a world setting`);
    const values = this.playerValues(id);
    const v = validateValue(def, value);
    if (values[key] === v) return false;
    values[key] = v;
    this.version++;
    this.storage.savePlayer(id, JSON.stringify(values));
    return true;
  }

  /** Forgets cached player values (player left). */
  dropPlayer(id: string): void {
    this.players.delete(id);
  }

  worldQualityFactor(): number {
    const q = QUALITY_OPTIONS[this.num('quality')];
    return q === 'custom' ? this.num('qualityFactor') : QUALITY_FACTORS[q];
  }

  effective(id: string): Effective {
    const p = this.playerValues(id);
    const pq = PLAYER_QUALITY_OPTIONS[p.pQuality as number];
    return {
      enabled: this.flag('enabled') && (p.pEnabled as boolean),
      distance: Math.min(this.num('maxDistance'), p.pDistance as number, MAX_LOD_CHUNKS),
      quality: pq === 'world' ? this.worldQualityFactor() : QUALITY_FACTORS[pq],
      res: Number(RES_OPTIONS[this.num('sampleRes')]),
      maxQuads: Math.min(this.num('maxQuads'), p.pQuads as number),
      hud: p.pHud as boolean,
    };
  }
}
