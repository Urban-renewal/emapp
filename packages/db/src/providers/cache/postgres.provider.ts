import { eq, inArray, gt, and, lt, sql } from 'drizzle-orm';

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

  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    if (keys.length === 0) return out;
    // ONE round-trip: fetch all requested, unexpired rows. The unexpired
    // filter runs DB-side so an expired row is simply absent (same semantics
    // as get()'s `expiresAt <= now` reject). PK-indexed `key IN (...)`.
    const rows = await db
      .select({ key: cacheKv.key, value: cacheKv.value })
      .from(cacheKv)
      .where(and(inArray(cacheKv.key, keys), gt(cacheKv.expiresAt, sql`now()`)));
    for (const r of rows) out.set(r.key, r.value as T);
    return out;
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
    // `cache_kv.value` is jsonb. The previous drizzle form set it to
    // `CAST(value AS integer) + 1` — an INTEGER expression, which Postgres
    // refuses to assign to a jsonb column (42804). Use the same explicit
    // round-trip the export rate-limiter uses: read the jsonb as text→int,
    // increment, cast BACK to jsonb (`::text::jsonb`). A non-numeric existing
    // value would throw — acceptable: this key is only ever an integer counter.
    const result = await db.execute<{ value: number }>(sql`
      INSERT INTO cache_kv (key, value, expires_at)
      VALUES (${key}, '1'::jsonb, ${expiresAt.toISOString()})
      ON CONFLICT (key) DO UPDATE
        SET value = ((cache_kv.value::text::int) + 1)::text::jsonb,
            updated_at = NOW()
      RETURNING value
    `);
    const row = (result as unknown as { rows: Array<{ value: unknown }> }).rows?.[0];
    // jsonb numeric comes back as a JS number; coalesce defensively. Mirrors
    // export-rate-limit.service.ts so both counter call-sites read identically.
    return Number(row?.value ?? 0);
  }

  async healthCheck(): Promise<void> {
    await db.execute(sql`SELECT 1`);
  }

  async cleanup(): Promise<void> {
    await db.delete(cacheKv).where(lt(cacheKv.expiresAt, new Date()));
  }
}
