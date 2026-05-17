import type { ICacheProvider } from './cache.interface';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class FakeCacheProvider implements ICacheProvider {
  private readonly store = new Map<string, CacheEntry>();

  private scopedKey(orgId: string, key: string): string {
    return `${orgId}:${key}`;
  }

  async get<T>(orgId: string, key: string): Promise<T | null> {
    const entry = this.store.get(this.scopedKey(orgId, key));
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value as T;
  }

  async set<T>(orgId: string, key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(this.scopedKey(orgId, key), {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async delete(orgId: string, key: string): Promise<void> {
    this.store.delete(this.scopedKey(orgId, key));
  }

  async incrementCounter(orgId: string, key: string, ttlSeconds: number): Promise<number> {
    const scoped = this.scopedKey(orgId, key);
    const entry = this.store.get(scoped);
    const current = entry && entry.expiresAt >= Date.now() ? (entry.value as number) : 0;
    const next = current + 1;
    this.store.set(scoped, { value: next, expiresAt: Date.now() + ttlSeconds * 1000 });
    return next;
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.store.clear();
  }
}
