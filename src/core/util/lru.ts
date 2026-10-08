/** Least-recently-used map built on Map insertion order. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    private capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Returns the value and marks it most recently used. */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  /** Returns the value without changing recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    this.trim();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  setCapacity(capacity: number): void {
    this.capacity = Math.max(1, capacity);
    this.trim();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  clear(): void {
    this.map.clear();
  }

  private trim(): void {
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      const v = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(oldest, v);
    }
  }
}
