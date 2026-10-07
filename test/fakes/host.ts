/** Core-level fake host: players walking around a FakeDimension world. */
import type { Host, HostDimension, HostPlayer, KV, MOLANG, Vec3 } from '../../src/core/types';
import { FakeDimension } from './terrain';

export class MemKV implements KV {
  data = new Map<string, string>();
  get(k: string) {
    return this.data.get(k);
  }
  set(k: string, v: string | undefined) {
    if (v === undefined) this.data.delete(k);
    else this.data.set(k, v);
  }
  keys() {
    return [...this.data.keys()];
  }
  totalBytes() {
    let n = 0;
    for (const [k, v] of this.data) n += (k.length + v.length) * 2;
    return n;
  }
}

export interface SpawnRecord {
  tick: number;
  effect: string;
  at: Vec3;
  vars: Record<keyof typeof MOLANG, number>;
}

export class FakePlayer implements HostPlayer {
  spawned: SpawnRecord[] = [];
  commands: string[] = [];
  bar: string[] = [];
  told: string[] = [];
  data = new Map<string, string>();
  valid = true;
  flying = false;
  op = true;
  dir: Vec3 = { x: 0, y: 0, z: 1 };
  failSpawns = false;

  constructor(
    readonly host: FakeHost,
    readonly id: string,
    public dim: FakeDimension,
    public pos: Vec3,
    readonly name = id,
  ) {}

  isValid() {
    return this.valid;
  }
  dimension(): HostDimension {
    return this.dim;
  }
  location() {
    return { ...this.pos };
  }
  eye() {
    return { x: this.pos.x, y: this.pos.y + 1.62, z: this.pos.z };
  }
  viewDirection() {
    return { ...this.dir };
  }
  isFlying() {
    return this.flying;
  }
  isOperator() {
    return this.op;
  }
  spawnParticle(effect: string, at: Vec3, vars: Readonly<Record<keyof typeof MOLANG, number>>) {
    if (this.failSpawns) throw new Error('LocationInUnloadedChunkError');
    if (!this.dim.isChunkLoaded(at.x, at.z)) throw new Error('LocationInUnloadedChunkError');
    this.spawned.push({ tick: this.host.tick, effect, at: { ...at }, vars: { ...vars } });
  }
  runCommand(cmd: string) {
    this.commands.push(cmd);
    return true;
  }
  actionBar(text: string) {
    this.bar.push(text);
  }
  tell(text: string) {
    this.told.push(text);
  }
  graphicsMode() {
    return 'Fancy';
  }
  memoryTier() {
    return 3;
  }
  maxRenderDistance() {
    return 32;
  }
  loadData(key: string) {
    return this.data.get(key);
  }
  saveData(key: string, value: string | undefined) {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}

/** Loads a disk of chunks around every player (like the server's view distance) plus ticking areas. */
export class FakeHost implements Host {
  tick = 0;
  ms = 0;
  kv = new MemKV();
  overworld = new FakeDimension('minecraft:overworld', 0);
  nether = new FakeDimension('minecraft:nether', 1, () => ({ blocks: [{ y: 127, typeId: 'minecraft:bedrock' }], ground: 127 }));
  end = new FakeDimension('minecraft:the_end', 2, () => undefined);
  list: FakePlayer[] = [];
  viewRadius = 6;
  areas = new Map<string, { dim: FakeDimension; x1: number; z1: number; x2: number; z2: number }>();
  /** Ticks a ticking area needs before its chunks load. */
  areaDelay = 2;
  private areaStarted = new Map<string, number>();
  time = 6000;
  cycle = true;
  logs: string[] = [];

  constructor() {
    for (const d of [this.overworld, this.nether, this.end]) {
      d.loaded = new Set();
      d.command = (cmd: string) => this.command(d, cmd);
    }
  }

  addPlayer(id: string, pos: Vec3, dim = this.overworld): FakePlayer {
    const p = new FakePlayer(this, id, dim, pos);
    this.list.push(p);
    this.refreshLoaded();
    return p;
  }

  players(): HostPlayer[] {
    return this.list.filter((p) => p.valid);
  }
  dimension(index: number) {
    return [this.overworld, this.nether, this.end][index];
  }
  currentTick() {
    return this.tick;
  }
  timeOfDay() {
    return this.time;
  }
  dayCycle() {
    return this.cycle;
  }
  /** Every call costs a little simulated time so time budgets terminate. */
  clock() {
    this.ms += 0.02;
    return this.ms;
  }
  log(message: string) {
    this.logs.push(message);
  }

  command(dim: FakeDimension, cmd: string): boolean {
    dim.commands.push(cmd);
    const add = /^tickingarea add (-?\d+) -?\d+ (-?\d+) (-?\d+) -?\d+ (-?\d+) (\S+)$/.exec(cmd);
    if (add) {
      if (this.areas.size >= 10) return false;
      const [x1, z1, x2, z2] = add.slice(1, 5).map(Number);
      this.areas.set(add[5], { dim, x1, z1, x2, z2 });
      this.areaStarted.set(add[5], this.tick);
      return true;
    }
    const rm = /^tickingarea remove (\S+)$/.exec(cmd);
    if (rm) {
      const had = this.areas.delete(rm[1]);
      this.refreshLoaded();
      return had;
    }
    return true;
  }

  refreshLoaded(): void {
    for (const d of [this.overworld, this.nether, this.end]) d.loaded!.clear();
    for (const p of this.list) {
      if (!p.valid) continue;
      const pcx = Math.floor(p.pos.x / 16);
      const pcz = Math.floor(p.pos.z / 16);
      const r = this.viewRadius;
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) p.dim.loaded!.add(`${pcx + dx},${pcz + dz}`);
    }
    for (const [name, a] of this.areas) {
      if (this.tick - (this.areaStarted.get(name) ?? 0) < this.areaDelay) continue;
      for (let cz = Math.floor(a.z1 / 16); cz <= Math.floor(a.z2 / 16); cz++)
        for (let cx = Math.floor(a.x1 / 16); cx <= Math.floor(a.x2 / 16); cx++) a.dim.loaded!.add(`${cx},${cz}`);
    }
  }

  /** Advances one tick: time, chunk loading. */
  advance(msPerTick = 50): void {
    this.tick++;
    this.ms += msPerTick;
    if (this.cycle) this.time = (this.time + 1) % 24000;
    this.refreshLoaded();
  }
}
