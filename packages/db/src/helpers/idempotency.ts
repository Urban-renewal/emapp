import { and, eq, lt, sql } from 'drizzle-orm';

import { db } from '../client';
import { cacheKv } from '../schema/artifacts';

// Idempotency store on cache_kv (MVP — no Redis, per stack). The CLAIM is
// the only concurrency-correct primitive: a single atomic statement that
// inserts the key when absent OR overwrites it only when the prior entry
// has EXPIRED, returning a row iff THIS caller won the claim. Two
// simultaneous requests with the same key → exactly one claims; the other
// observes the in-flight/finished record.

const PENDING_TTL_MS = 60_000; // a crashed in-flight request frees after 1m
const DONE_TTL_MS = 24 * 60 * 60 * 1000; // replay window for a completed op

export interface IdempotencyRecord {
  state: 'pending' | 'done';
  status?: number;
  body?: unknown;
}

/** @returns true iff THIS caller atomically claimed the key. */
export async function idempotencyClaim(key: string): Promise<boolean> {
  const now = new Date();
  const won = await db
    .insert(cacheKv)
    .values({
      key,
      value: { state: 'pending' } as IdempotencyRecord,
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    })
    .onConflictDoUpdate({
      target: cacheKv.key,
      set: {
        value: { state: 'pending' } as IdempotencyRecord,
        expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
        updatedAt: now,
      },
      // Only steal the slot if the previous holder's entry has expired.
      setWhere: lt(cacheKv.expiresAt, now),
    })
    .returning({ key: cacheKv.key });
  return won.length > 0;
}

/** The current record for a key that we did NOT claim (or null if gone). */
export async function idempotencyPeek(key: string): Promise<IdempotencyRecord | null> {
  const now = new Date();
  const [row] = await db
    .select({ value: cacheKv.value, expiresAt: cacheKv.expiresAt })
    .from(cacheKv)
    .where(eq(cacheKv.key, key))
    .limit(1);
  if (!row || row.expiresAt <= now) return null;
  return row.value as IdempotencyRecord;
}

/** Persist the finished response for replay within the done-TTL. */
export async function idempotencyComplete(
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const now = new Date();
  await db
    .update(cacheKv)
    .set({
      value: { state: 'done', status, body } as IdempotencyRecord,
      expiresAt: new Date(now.getTime() + DONE_TTL_MS),
      updatedAt: now,
    })
    .where(and(eq(cacheKv.key, key), sql`true`));
}

/** Release a claim so a FAILED operation can be retried. */
export async function idempotencyRelease(key: string): Promise<void> {
  await db.delete(cacheKv).where(eq(cacheKv.key, key));
}
