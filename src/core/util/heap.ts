/** Binary min-heap keyed by a number. */
export class MinHeap<T> {
  private readonly items: T[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  peek(): T | undefined {
    return this.items[0];
  }

  peekKey(): number {
    return this.keys.length ? this.keys[0] : Infinity;
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const lastItem = this.items.pop() as T;
    const lastKey = this.keys.pop() as number;
    if (n > 1) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n - 1 && this.keys[l] < this.keys[m]) m = l;
        if (r < n - 1 && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  clear(): void {
    this.items.length = 0;
    this.keys.length = 0;
  }

  private swap(a: number, b: number): void {
    const t = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = t;
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
  }
}
