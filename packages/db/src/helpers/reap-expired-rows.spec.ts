/**
 * ADVERSARIAL real-DB tests for the expired-row reaper (Phase 3 #5a).
 *
 * Author: TEST-AUTHOR (separate from the builder). These tests do NOT
 * trust reapExpiredRows. The load-bearing risk is a bad WHERE clause that
 * DELETES A LIVE session / OTP / cache row. The #1 job of this file is to
 * PROVE that cannot happen: for every target table we seed one clearly-
 * expired row and one clearly-live row (unique keys), run the reaper, and
 * assert the expired one is gone AND the live one still exists.
 *
 * Why raw SQL on `providerPool` (BYPASSRLS) for seed/verify:
 *  - These tables are system/auth, NOT tenant-scoped (no RLS context to
 *    set), and the reaper itself runs on the same BYPASSRLS pool — so the
 *    test setup mirrors production reality.
 *  - Raw SQL lets us insert FK-parent placeholders (encrypted bytea
 *    columns get throwaway bytes) without dragging in the encryption
 *    helpers — content is irrelevant to a reaper test.
 *
 * All seeded rows carry a UNIQUE run marker so concurrent suites on the
 * shared dev DB never collide, and afterAll deletes everything this file
 * created (parents + any survivors) so we don't pollute the shared DB.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../client';

import {
  reapExpiredRows,
  REAP_TARGETS,
  type ReapLogger,
  type ReapTarget,
} from './reap-expired-rows';

// ── A fake logger that RECORDS every call so we can inspect what the
//    reaper logged (test #5: no PII / row content in the summary). ──────
interface LoggedCall {
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}
function makeRecordingLogger(): { log: ReapLogger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const log: ReapLogger = {
    info: (msg, meta) => calls.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => calls.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => calls.push({ level: 'error', msg, meta }),
  };
  return { log, calls };
}

// A unique-per-run tag woven into every seeded key so a parallel suite on
// the shared dev DB can never match (or delete) our rows, and so our
// afterAll cleanup targets ONLY this file's rows.
const RUN = randomUUID().slice(0, 8);

// Clearly-separated timestamps — NOT now()±epsilon, to keep the survival
// assertions deterministic under clock skew / test latency.
const PAST = "now() - interval '60 seconds'"; // unambiguously expired
const FUTURE = "now() + interval '3600 seconds'"; // unambiguously live

// FK-parent ids, seeded once in beforeAll.
let orgId: string;
let userId: string;
let ownerId: string;

// Helper: run a raw query on the BYPASSRLS pool.
async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await providerPool.connect();
  try {
    const r = await client.query(text, params);
    return r.rows as T[];
  } finally {
    client.release();
  }
}

async function exists(table: string, idCol: string, idVal: string): Promise<boolean> {
  const rows = await q(`SELECT 1 FROM ${table} WHERE ${idCol} = $1`, [idVal]);
  return rows.length > 0;
}

beforeAll(async () => {
  // Parent org.
  const [org] = await q<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`reaper-test-${RUN}`, `reaper-test-${RUN}`],
  );
  orgId = org!.id;

  // Parent user (auth_sessions.user_id FK).
  const [user] = await q<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [`reaper-${RUN}@test.local`, 'Reaper Test User', '$argon2id$placeholder'],
  );
  userId = user!.id;

  // Parent owner (tenant_sessions.owner_id FK). Encrypted bytea columns
  // are notNull but have no content CHECK — throwaway bytes are fine for
  // an FK parent in a reaper test.
  const [owner] = await q<{ id: string }>(
    `INSERT INTO owners
       (org_id, name_encrypted, name_hash, national_id_encrypted, national_id_hash)
     VALUES ($1, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, $2)
     RETURNING id`,
    [orgId, `reaper-natid-${RUN}`],
  );
  ownerId = owner!.id;
});

afterAll(async () => {
  // Delete child rows first (FK order), then parents. Scoped to THIS run.
  await q(`DELETE FROM auth_sessions WHERE token_hash LIKE $1`, [`reap-${RUN}-%`]);
  await q(`DELETE FROM tenant_sessions WHERE owner_id = $1`, [ownerId]);
  await q(`DELETE FROM otp_codes WHERE phone_hash LIKE $1`, [`reap-${RUN}-%`]);
  await q(`DELETE FROM cache_kv WHERE key LIKE $1`, [`reap:${RUN}:%`]);
  await q(`DELETE FROM owners WHERE id = $1`, [ownerId]);
  await q(`DELETE FROM users WHERE id = $1`, [userId]);
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId]);
});

// ── Seed helpers: each returns the unique id/key of the seeded row so the
//    test can query it back. `when` is a raw SQL interval expression. ────

async function seedAuthSession(tag: string, when: string): Promise<string> {
  const id = randomUUID();
  const tokenHash = `reap-${RUN}-${tag}-${id}`;
  await q(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, ${when})`,
    [id, userId, tokenHash],
  );
  return id;
}

async function seedTenantSession(tag: string, when: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO tenant_sessions (id, owner_id, org_id, expires_at)
     VALUES ($1, $2, $3, ${when})`,
    [id, ownerId, orgId],
  );
  return id;
}

async function seedOtp(tag: string, when: string): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO otp_codes (id, phone_hash, code_hash, expires_at)
     VALUES ($1, $2, $3, ${when})`,
    [id, `reap-${RUN}-${tag}`, `code-${RUN}-${tag}`],
  );
  return id;
}

async function seedCache(tag: string, when: string): Promise<string> {
  const key = `reap:${RUN}:${tag}:${randomUUID()}`;
  await q(
    `INSERT INTO cache_kv (key, value, expires_at)
     VALUES ($1, $2::jsonb, ${when})`,
    [key, JSON.stringify({ marker: tag })],
  );
  return key;
}

describe('reapExpiredRows — REAL DB (Phase 3 #5a)', () => {
  // ─────────────────────────────────────────────────────────────────────
  // TEST 1 — THE LOAD-BEARING PROOF. Per table: expired GONE, live SURVIVES.
  // ─────────────────────────────────────────────────────────────────────
  describe('1. only-expired-deleted, every-live-survives (per table)', () => {
    it('auth_sessions: deletes the expired row, KEEPS the live row', async () => {
      const expiredId = await seedAuthSession('live-proof-exp', PAST);
      const liveId = await seedAuthSession('live-proof-live', FUTURE);

      expect(await exists('auth_sessions', 'id', expiredId)).toBe(true); // sanity
      expect(await exists('auth_sessions', 'id', liveId)).toBe(true); // sanity

      const { log } = makeRecordingLogger();
      await reapExpiredRows(log);

      expect(await exists('auth_sessions', 'id', expiredId)).toBe(false);
      // CATASTROPHE CHECK — a live org session MUST survive the reaper.
      expect(await exists('auth_sessions', 'id', liveId)).toBe(true);
    });

    it('tenant_sessions: deletes the expired row, KEEPS the live row', async () => {
      const expiredId = await seedTenantSession('live-proof-exp', PAST);
      const liveId = await seedTenantSession('live-proof-live', FUTURE);

      expect(await exists('tenant_sessions', 'id', expiredId)).toBe(true);
      expect(await exists('tenant_sessions', 'id', liveId)).toBe(true);

      const { log } = makeRecordingLogger();
      await reapExpiredRows(log);

      expect(await exists('tenant_sessions', 'id', expiredId)).toBe(false);
      // CATASTROPHE CHECK — a live tenant-portal session MUST survive.
      expect(await exists('tenant_sessions', 'id', liveId)).toBe(true);
    });

    it('otp_codes: deletes the expired row, KEEPS the live row', async () => {
      const expiredId = await seedOtp('live-proof-exp', PAST);
      const liveId = await seedOtp('live-proof-live', FUTURE);

      expect(await exists('otp_codes', 'id', expiredId)).toBe(true);
      expect(await exists('otp_codes', 'id', liveId)).toBe(true);

      const { log } = makeRecordingLogger();
      await reapExpiredRows(log);

      expect(await exists('otp_codes', 'id', expiredId)).toBe(false);
      // CATASTROPHE CHECK — a still-redeemable OTP MUST survive.
      expect(await exists('otp_codes', 'id', liveId)).toBe(true);
    });

    it('cache_kv: deletes the expired row, KEEPS the live row', async () => {
      const expiredKey = await seedCache('live-proof-exp', PAST);
      const liveKey = await seedCache('live-proof-live', FUTURE);

      expect(await exists('cache_kv', 'key', expiredKey)).toBe(true);
      expect(await exists('cache_kv', 'key', liveKey)).toBe(true);

      const { log } = makeRecordingLogger();
      await reapExpiredRows(log);

      expect(await exists('cache_kv', 'key', expiredKey)).toBe(false);
      // CATASTROPHE CHECK — a live cache entry MUST survive.
      expect(await exists('cache_kv', 'key', liveKey)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // TEST 2 — Boundary: the `< now()` cutoff. Past-by-1s deleted,
  // future-by-1s kept. We assert on cache_kv (no FK overhead). The tight
  // boundary is deterministic because the predicate is evaluated against
  // the DB clock at DELETE time, and 1s on either side of a snapshot taken
  // a few ms earlier is on the correct side of now().
  // ─────────────────────────────────────────────────────────────────────
  describe('2. boundary around now()', () => {
    it('a row 1s in the past is reaped; a row 1s in the future is kept', async () => {
      const justExpired = await seedCache('boundary-past', "now() - interval '1 second'");
      const justFuture = await seedCache('boundary-future', "now() + interval '1 second'");

      const { log } = makeRecordingLogger();
      await reapExpiredRows(log);

      expect(await exists('cache_kv', 'key', justExpired)).toBe(false);
      expect(await exists('cache_kv', 'key', justFuture)).toBe(true);
    });

    it('the descriptor predicate is exactly `expires_at < now()` (strict <, excludes NULL)', () => {
      // Pin the predicate text so a future edit to >=, <=, or a different
      // column trips this test. The strict `<` is what keeps a row whose
      // expires_at == now() alive for one more tick (no off-by-one delete),
      // and `< now()` is NULL-safe (NULL < x is NULL, never true).
      for (const t of REAP_TARGETS) {
        const rendered = JSON.stringify(t.whereExpired);
        // drizzle sql`` serialises the literal chunks into queryChunks.
        expect(rendered).toContain('expires_at <');
        expect(rendered).toContain('now()');
        expect(rendered).not.toContain('<=');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // TEST 3 — Idempotent. Second run deletes 0 of the seeded set; live rows
  // still survive.
  // ─────────────────────────────────────────────────────────────────────
  describe('3. idempotent', () => {
    it('running twice: 2nd run deletes 0 of our seeded rows; live rows survive both', async () => {
      const authExp = await seedAuthSession('idem-exp', PAST);
      const authLive = await seedAuthSession('idem-live', FUTURE);
      const cacheExp = await seedCache('idem-exp', PAST);
      const cacheLive = await seedCache('idem-live', FUTURE);

      const { log } = makeRecordingLogger();

      // 1st run reaps the expired rows.
      await reapExpiredRows(log);
      expect(await exists('auth_sessions', 'id', authExp)).toBe(false);
      expect(await exists('cache_kv', 'key', cacheExp)).toBe(false);

      // Count OUR remaining expired rows before the 2nd run — must be 0,
      // so the 2nd run cannot delete any of ours.
      const ourExpiredBefore2nd = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM cache_kv
           WHERE key LIKE $1 AND expires_at < now()`,
        [`reap:${RUN}:idem-%`],
      );
      expect(Number(ourExpiredBefore2nd[0]!.n)).toBe(0);

      // 2nd run — idempotent. Live rows still survive.
      await reapExpiredRows(log);
      expect(await exists('auth_sessions', 'id', authLive)).toBe(true);
      expect(await exists('cache_kv', 'key', cacheLive)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // TEST 4 — Per-table best-effort. A bogus descriptor (non-existent
  // table) must NOT abort the run: the real table is still reaped and the
  // failure is captured in `failures` / results[].error, not thrown.
  // ─────────────────────────────────────────────────────────────────────
  describe('4. per-table best-effort (one bad target does not abort the rest)', () => {
    it('reaps the real table even when a bogus target fails; failure captured not thrown', async () => {
      const realExpired = await seedCache('besteffort-exp', PAST);
      const realLive = await seedCache('besteffort-live', FUTURE);

      const bogus: ReapTarget = {
        table: `does_not_exist_${RUN}`,
        // A predicate referencing the (missing) table — DELETE will throw.
        whereExpired: REAP_TARGETS[0]!.whereExpired,
      };
      const realCache = REAP_TARGETS.find((t) => t.table === 'cache_kv')!;

      const { log, calls } = makeRecordingLogger();
      // Bogus FIRST — proves a failure on target[0] doesn't strand target[1].
      const result = await reapExpiredRows(log, [bogus, realCache]);

      // The real table WAS reaped despite the earlier failure.
      expect(await exists('cache_kv', 'key', realExpired)).toBe(false);
      expect(await exists('cache_kv', 'key', realLive)).toBe(true);

      // The failure is captured, not thrown.
      expect(result.failures).toBe(1);
      const bogusResult = result.results.find((r) => r.table === bogus.table);
      expect(bogusResult).toBeDefined();
      expect(bogusResult!.deleted).toBe(0);
      expect(bogusResult!.error).toBeTruthy();

      // The real table reported a success entry (no error) alongside it.
      const realResult = result.results.find((r) => r.table === 'cache_kv');
      expect(realResult!.error).toBeUndefined();
      expect(realResult!.deleted).toBeGreaterThanOrEqual(1);

      // It was logged at error level (continuing), not raised.
      expect(calls.some((c) => c.level === 'error')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // TEST 5 — Counts are integers; the returned/logged summary carries NO
  // row content / PII (no token hash, OTP code, cache value, phone).
  // ─────────────────────────────────────────────────────────────────────
  describe('5. integer counts + no PII / row content in the summary', () => {
    it('results report per-table integer deleted counts and no row content', async () => {
      const tokenHashSecret = `reap-${RUN}-pii-secret-token`;
      // Seed an expired auth_session whose token_hash is a known secret.
      const id = randomUUID();
      await q(
        `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, ${PAST})`,
        [id, userId, tokenHashSecret],
      );
      const cacheSecretKey = await seedCache('pii-secret', PAST);

      const { log, calls } = makeRecordingLogger();
      const result = await reapExpiredRows(log);

      // Per-table integer counts.
      expect(result.results.length).toBe(REAP_TARGETS.length);
      for (const r of result.results) {
        expect(Number.isInteger(r.deleted)).toBe(true);
        expect(r.deleted).toBeGreaterThanOrEqual(0);
        expect(typeof r.table).toBe('string');
      }
      expect(Number.isInteger(result.totalDeleted)).toBe(true);
      expect(Number.isInteger(result.failures)).toBe(true);

      // The summary keys are exactly {table, deleted, error?} — no value/
      // token/code field that could carry a row's content.
      for (const r of result.results) {
        const keys = Object.keys(r).sort();
        expect(keys.every((k) => ['table', 'deleted', 'error'].includes(k))).toBe(true);
      }

      // NO PII / row content anywhere in the returned summary...
      const summaryBlob = JSON.stringify(result);
      expect(summaryBlob).not.toContain(tokenHashSecret);
      expect(summaryBlob).not.toContain(cacheSecretKey);
      expect(summaryBlob).not.toContain('pii-secret');

      // ...nor in anything the reaper logged.
      const logBlob = JSON.stringify(calls);
      expect(logBlob).not.toContain(tokenHashSecret);
      expect(logBlob).not.toContain(cacheSecretKey);
      // The only meta the reaper logs is {table, deleted} (+ error on fail).
      for (const c of calls) {
        if (!c.meta) continue;
        const metaKeys = Object.keys(c.meta);
        expect(metaKeys.every((k) => ['table', 'deleted', 'error'].includes(k))).toBe(true);
      }
    });
  });
});
