/**
 * V11 Wave 6 EXP-H1 — DB-backed per-user export rate limit.
 *
 * Coverage:
 *   1) Sequential calls within the LIMIT are all allowed; `remaining`
 *      decrements correctly.
 *   2) The (LIMIT+1)th call is denied with a positive retryAfterSec.
 *   3) Two different users get independent buckets (no cross-user
 *      pollution — the bucket key includes the userId).
 *   4) Atomic increment: launching LIMIT*2 concurrent calls from one
 *      user yields exactly LIMIT allowed + the rest denied (no
 *      double-counts or missed counts under contention — proves the
 *      ON CONFLICT upsert path serialises correctly).
 */
import { randomUUID } from 'node:crypto';

import { cacheKv, db } from '@emapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import { ExportRateLimitService } from './export-rate-limit.service';

setupTestDatabase();

const svc = new ExportRateLimitService();
const LIMIT = ExportRateLimitService.LIMIT;

function uniqueUserId(_suffix: string): string {
  // Real UUIDs so tests can't collide via slice-truncation. The
  // suffix param is kept for call-site readability; ignored.
  return randomUUID();
}

async function clearKey(userId: string): Promise<void> {
  // Wipe any pre-existing buckets for this userId so tests are
  // hermetic. We can't predict the exact hour bucket from the test
  // side easily, so delete by prefix via LIKE.
  await db.execute(
    // raw query — drizzle's like() vs delete chain is fussy here, and
    // this is a test-only cleanup, not user-facing code.
    /* sql */ `DELETE FROM cache_kv WHERE key LIKE 'export:rl:u:${userId}:%'` as never,
  );
}

beforeAll(async () => {
  // Sanity ping
  expect(LIMIT).toBeGreaterThan(0);
});

afterAll(async () => {
  // Best-effort cleanup; we leak a handful of rows but cache_kv's
  // expires_at sweep handles them.
});

describe('V11 Wave 6 EXP-H1 · ExportRateLimitService', () => {
  it('1) sequential calls within LIMIT are all allowed; remaining decrements', async () => {
    const user = uniqueUserId('seq');
    await clearKey(user);
    for (let i = 0; i < LIMIT; i += 1) {
      const v = await svc.checkAndIncrement(user);
      expect(v.allowed).toBe(true);
      expect(v.remaining).toBe(LIMIT - (i + 1));
      expect(v.retryAfterSec).toBeUndefined();
    }
  });

  it('2) the (LIMIT+1)th call is denied with positive retryAfterSec', async () => {
    const user = uniqueUserId('deny');
    await clearKey(user);
    for (let i = 0; i < LIMIT; i += 1) {
      await svc.checkAndIncrement(user);
    }
    const v = await svc.checkAndIncrement(user);
    expect(v.allowed).toBe(false);
    expect(v.remaining).toBe(0);
    expect(v.retryAfterSec).toBeGreaterThan(0);
    // Within the hour — the longest retry should be ~3600s.
    expect(v.retryAfterSec).toBeLessThanOrEqual(3600);
  });

  it('3) two users get independent buckets (no cross-user pollution)', async () => {
    const userA = uniqueUserId('a');
    const userB = uniqueUserId('b');
    await clearKey(userA);
    await clearKey(userB);
    // Burn A's bucket to the limit.
    for (let i = 0; i < LIMIT; i += 1) {
      await svc.checkAndIncrement(userA);
    }
    const aDenied = await svc.checkAndIncrement(userA);
    expect(aDenied.allowed).toBe(false);
    // B is untouched.
    const bFirst = await svc.checkAndIncrement(userB);
    expect(bFirst.allowed).toBe(true);
    expect(bFirst.remaining).toBe(LIMIT - 1);
  });

  it('4) atomic increment under concurrent contention — exactly LIMIT allowed', async () => {
    const user = uniqueUserId('race');
    await clearKey(user);
    // Fire LIMIT*2 calls concurrently. The atomic UPSERT must
    // serialise them so the post-counter values are 1..2*LIMIT
    // with no gaps and no duplicates. Exactly LIMIT verdicts
    // should be allowed.
    const verdicts = await Promise.all(
      Array.from({ length: LIMIT * 2 }, () => svc.checkAndIncrement(user)),
    );
    const allowedCount = verdicts.filter((v) => v.allowed).length;
    expect(allowedCount).toBe(LIMIT);
    // Sanity — every denied has a retryAfterSec.
    for (const v of verdicts.filter((v) => !v.allowed)) {
      expect(v.retryAfterSec).toBeGreaterThan(0);
    }
    // The stored counter should be exactly 2*LIMIT.
    const [row] = await db
      .select({ value: cacheKv.value })
      .from(cacheKv)
      .where(eq(cacheKv.key, `export:rl:u:${user}:${currentBucket()}`))
      .limit(1);
    expect(Number(row?.value)).toBe(LIMIT * 2);
  });
});

function currentBucket(): string {
  const now = new Date();
  return (
    now.getUTCFullYear().toString().padStart(4, '0') +
    (now.getUTCMonth() + 1).toString().padStart(2, '0') +
    now.getUTCDate().toString().padStart(2, '0') +
    now.getUTCHours().toString().padStart(2, '0')
  );
}
