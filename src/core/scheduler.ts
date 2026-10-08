/** A source of small units of work. `next()` returns a generator for the next unit, or undefined when idle. */
export interface Job {
  next(): Generator<void, unknown, void> | undefined;
}

/**
 * Cooperative scheduler: advances one job by one generator step at a time, in weighted round-robin order, until a
 * millisecond budget is used. Units may span many steps (and ticks); each job keeps its in-progress unit.
 */
export class Scheduler {
  private readonly jobs: Job[] = [];
  private readonly names: string[] = [];
  private readonly current: (Generator<void, unknown, void> | undefined)[] = [];
  private order: number[] = [];
  private pos = 0;
  /** Steps executed per job name (diagnostics). */
  readonly steps = new Map<string, number>();
  /** Longest single step per job name in ms (diagnostics; spikes show up here). */
  readonly maxStepMs = new Map<string, number>();
  /** Optional diagnostics hook called after every step. */
  onStep: ((name: string, ms: number) => void) | undefined;

  constructor(private readonly clock: () => number) {}

  add(name: string, job: Job, weight = 1): void {
    const index = this.jobs.length;
    this.jobs.push(job);
    this.names.push(name);
    this.current.push(undefined);
    for (let i = 0; i < weight; i++) this.order.push(index);
    // Interleave so heavy jobs do not run in long streaks.
    this.order = interleave(this.order);
  }

  /** Advances work by one step. Returns false when every job is idle. */
  step(): boolean {
    const n = this.order.length;
    for (let tries = 0; tries < n; tries++) {
      const j = this.order[this.pos];
      this.pos = (this.pos + 1) % n;
      let g = this.current[j];
      if (!g) {
        g = this.jobs[j].next();
        if (!g) continue;
        this.current[j] = g;
      }
      const name = this.names[j];
      this.steps.set(name, (this.steps.get(name) ?? 0) + 1);
      let done = true;
      const t0 = this.clock();
      try {
        done = g.next().done === true;
      } finally {
        if (done) this.current[j] = undefined;
        const ms = this.clock() - t0;
        if (ms > (this.maxStepMs.get(name) ?? 0)) this.maxStepMs.set(name, ms);
        this.onStep?.(name, ms);
      }
      return true;
    }
    return false;
  }

  /** Runs steps until `budgetMs` has elapsed or all jobs are idle. */
  runFor(budgetMs: number): void {
    const end = this.clock() + budgetMs;
    while (this.clock() < end && this.step());
  }

  /** Like runFor, but yields between steps (for system.runJob). */
  *slice(budgetMs: number): Generator<void, void, void> {
    const end = this.clock() + budgetMs;
    while (this.clock() < end && this.step()) yield;
  }

  /** Drops in-progress units (e.g. after a reset). */
  abortAll(): void {
    for (let i = 0; i < this.current.length; i++) {
      try {
        this.current[i]?.return(undefined);
      } catch {
        // ignore errors from finally blocks of aborted units
      }
      this.current[i] = undefined;
    }
  }
}

function interleave(order: number[]): number[] {
  const counts = new Map<number, number>();
  for (const j of order) counts.set(j, (counts.get(j) ?? 0) + 1);
  const out: number[] = [];
  const total = order.length;
  const credit = new Map<number, number>();
  for (let i = 0; i < total; i++) {
    let best = -1;
    let bestCredit = -Infinity;
    for (const [j, c] of counts) {
      const cr = (credit.get(j) ?? 0) + c;
      credit.set(j, cr);
      if (cr > bestCredit) {
        bestCredit = cr;
        best = j;
      }
    }
    credit.set(best, (credit.get(best) ?? 0) - total);
    out.push(best);
  }
  return out;
}
