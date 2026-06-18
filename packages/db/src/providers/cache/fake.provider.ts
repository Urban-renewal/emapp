import type { ICacheProvider } from './cache.interface';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class FakeCacheProvider implements ICacheProvider {
  private readonly store = new Map<string, CacheEntry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value as T;
  }

  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const now = Date.now();
    for (const key of keys) {
      const entry = this.store.get(key);
      if (entry && entry.expiresAt >= now) out.set(key, entry.value as T);
    }
    return out;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incrementCounter(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.store.get(key);
    const current = entry && entry.expiresAt >= Date.now() ? (entry.value as number) : 0;
    const next = current + 1;
    this.store.set(key, { value: next, expiresAt: Date.now() + ttlSeconds * 1000 });
    return next;
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.store.clear();
  }
}
