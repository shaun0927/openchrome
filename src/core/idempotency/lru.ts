/** Small TTL + LRU cache for per-session idempotency maps (#842). */

export interface LruTtlCacheOptions {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
  onEvict?: (reason: 'ttl' | 'lru') => void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruTtlCache<V> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onEvict?: (reason: 'ttl' | 'lru') => void;
  private readonly entries = new Map<string, Entry<V>>();

  constructor(options: LruTtlCacheOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.now = options.now ?? Date.now;
    this.onEvict = options.onEvict;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.onEvict?.('ttl');
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
      this.onEvict?.('lru');
    }
  }

  size(): number {
    return this.entries.size;
  }
}
