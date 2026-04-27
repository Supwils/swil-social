/**
 * Tiny in-process TTL cache for read-heavy aggregate computations
 * (trending tags, explore summaries, etc).
 *
 * Single-process only — restart clears all entries. For multi-process
 * scaling, swap the underlying Map for Redis.
 */
type Entry<V> = { value: V; expiresAt: number };

export class TTLCache<K, V> {
  private store = new Map<K, Entry<V>>();

  constructor(private ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /**
   * Read-through wrapper: returns the cached value if fresh, otherwise
   * runs `loader`, caches the result, and returns it. Concurrent callers
   * with a missing key will each run `loader` once (no single-flight) —
   * acceptable for our low-contention workload.
   */
  async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    this.set(key, value);
    return value;
  }
}
