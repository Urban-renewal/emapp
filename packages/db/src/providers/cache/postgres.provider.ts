import { eq, lt, sql } from 'drizzle-orm';

import { db } from '../../client';
import { cacheKv } from '../../schema/artifacts';

import type { ICacheProvider } from './cache.interface';

export class PostgresCacheProvider implements ICacheProvider {
  async get<T>(key: string): Promise<T | null> {
    const now = new Date();
    const rows = await db.select().from(cacheKv).where(eq(cacheKv.key, key)).limit(1);

    const row = rows[0];
    if (!row || row.expiresAt <= now) return null;
    return row.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await db
      .insert(cacheKv)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({
        target: cacheKv.key,
        set: { value, expiresAt, updatedAt: new Date() },
      });
  }

  async delete(key: string): Promise<void> {
    await db.delete(cacheKv).where(eq(cacheKv.key, key));
  }

  async incrementCounter(key: string, ttlSeconds: number): Promise<number> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const result = await db
      .insert(cacheKv)
      .values({ key, value: 1, expiresAt })
      .onConflictDoUpdate({
        target: cacheKv.key,
        set: {
          value: sql`CAST(${cacheKv.value} AS integer) + 1`,
          expiresAt,
          updatedAt: new Date(),
        },
      })
      .returning({ value: cacheKv.value });

    const row = result[0];
    return typeof row?.value === 'number' ? row.value : 1;
  }

  async healthCheck(): Promise<void> {
    await db.execute(sql`SELECT 1`);
  }

  async cleanup(): Promise<void> {
    await db.delete(cacheKv).where(lt(cacheKv.expiresAt, new Date()));
  }
}
