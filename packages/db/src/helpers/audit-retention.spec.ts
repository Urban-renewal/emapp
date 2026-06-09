/**
 * Tests for the audit-log retention prune (Roadmap P0.C3 / compliance).
 *
 * Two parts:
 *  A. PURE clamp tests (no DB) — the load-bearing guarantee: the effective
 *     retention window can NEVER drop below the 24-month regulatory floor,
 *     whatever AUDIT_RETENTION_MONTHS is set to. A 12-month config is forced
 *     to 24; unset → default 36; junk → default; ≥24 honoured. Plus the
 *     `isAuditLogImmutableError` recogniser (cause-chain aware).
 *  B. REAL-DB proofs of the Gate-6 carve-out (migration 0060). The
 *     append-only `trg_audit_log_immutable` trigger now allows EXACTLY ONE
 *     mutation — DELETE of a row older than the 24-month hard floor — and
 *     still RAISES on every UPDATE and on DELETE of any row inside the floor.
 *     These specs prove the boundary is TIGHT (B1, the trigger contract) and
 *     that `pruneAuditLog` deletes only aged-out rows in batches (B2–B5).
 *
 * NOTE: we deliberately NEVER disable the immutability trigger — the carve-out
 * IS the security control (migration 0060), exercised through the standard
 * migrate() path (global-setup applies pending migrations to the test DB), not
 * via manual DDL or `DISABLE TRIGGER`. Every seed here is scoped to a unique
 * throwaway org and recent (non-prunable) rows are removed in afterEach using
 * the same carve-out (delete only works past the floor → recent cleanup goes
 * through a direct provider connection AFTER aging is irrelevant; see below),
 * so the shared test DB is left clean.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../client';

import {
  AUDIT_RETENTION_DEFAULT_MONTHS,
  AUDIT_RETENTION_FLOOR_MONTHS,
  isAuditLogImmutableError,
  pruneAuditLog,
  resolveRetentionMonths,
} from './audit-retention';
import type { ReapLogger } from './reap-expired-rows';

// ── A fake logger that RECORDS calls so we can assert the clamp warning and
//    the no-PII evidence line. ──────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────
// PART A — PURE clamp tests (no DB). The compliance floor.
// ──────────────────────────────────────────────────────────────────────────
describe('resolveRetentionMonths — the ≥24-month floor (P0.C3)', () => {
  it('the floor constant is 24 and the default is 36', () => {
    expect(AUDIT_RETENTION_FLOOR_MONTHS).toBe(24);
    expect(AUDIT_RETENTION_DEFAULT_MONTHS).toBe(36);
  });

  it('a 12-month config is FORCED UP to 24 (the load-bearing guarantee)', () => {
    const { log, calls } = makeRecordingLogger();
    expect(resolveRetentionMonths('12', log)).toBe(24);
    // The override is logged at WARN (visible) but does NOT take effect.
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('ANY value below 24 clamps to exactly 24', () => {
    expect(resolveRetentionMonths('1')).toBe(24);
    expect(resolveRetentionMonths('23')).toBe(24);
    expect(resolveRetentionMonths('23.9')).toBe(24);
    // 0 / negative are treated as unset → default, not clamped-to-floor,
    // but the result is still ≥ 24, which is all the floor guarantees.
    expect(resolveRetentionMonths('0')).toBeGreaterThanOrEqual(24);
    expect(resolveRetentionMonths('-5')).toBeGreaterThanOrEqual(24);
  });

  it('exactly 24 is honoured (boundary)', () => {
    expect(resolveRetentionMonths('24')).toBe(24);
  });

  it('a value ABOVE the floor is honoured (operators may keep longer)', () => {
    expect(resolveRetentionMonths('36')).toBe(36);
    expect(resolveRetentionMonths('60')).toBe(60);
    // Fractional ≥ floor is floored to a whole month.
    expect(resolveRetentionMonths('48.7')).toBe(48);
  });

  it('unset / empty / non-numeric falls back to the default (36, ≥ floor)', () => {
    expect(resolveRetentionMonths(undefined)).toBe(AUDIT_RETENTION_DEFAULT_MONTHS);
    expect(resolveRetentionMonths('')).toBe(AUDIT_RETENTION_DEFAULT_MONTHS);
    expect(resolveRetentionMonths('not-a-number')).toBe(AUDIT_RETENTION_DEFAULT_MONTHS);
    // No matter the junk, the result is never below the floor.
    for (const junk of [undefined, '', 'abc', 'NaN', '  ']) {
      expect(resolveRetentionMonths(junk)).toBeGreaterThanOrEqual(AUDIT_RETENTION_FLOOR_MONTHS);
    }
  });
});

describe('isAuditLogImmutableError — recognises the blocker through wrapping', () => {
  it('matches a direct immutability error', () => {
    expect(isAuditLogImmutableError(new Error('audit_log rows are immutable'))).toBe(true);
  });

  it('matches when wrapped in a drizzle "Failed query" error via .cause', () => {
    const pg = new Error('audit_log rows are immutable');
    const wrapped = new Error('Failed query: DELETE FROM audit_log ...', { cause: pg });
    expect(isAuditLogImmutableError(wrapped)).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isAuditLogImmutableError(new Error('connection refused'))).toBe(false);
    expect(isAuditLogImmutableError(undefined)).toBe(false);
    expect(isAuditLogImmutableError(null)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PART B — REAL-DB proofs of the Gate-6 carve-out (migration 0060).
// ──────────────────────────────────────────────────────────────────────────
//
// The carve-out replaced the blanket immutability trigger with an age-gated
// one (see 0060):
//   - UPDATE                      → ALWAYS raises.
//   - DELETE inside the 24mo floor → raises.
//   - DELETE older than 24mo       → permitted (this is what the prune uses).
//
// Seeding strategy that NEVER pollutes the shared test DB:
//   - Every row carries a unique per-run `action` marker (see `mark()`) scoped
//     to one throwaway org, so a parallel suite can never collide and so our
//     cleanup targets ONLY our rows.
//   - "Old" rows (> 24mo) are committed so the real `pruneAuditLog` can act on
//     them; whatever the prune leaves behind is itself > 24mo, so afterEach can
//     legally DELETE it through the same carve-out → zero residue.
//   - Anything we need INSIDE the 24mo floor (which the carve-out forbids
//     deleting, hence cannot be cleaned) is exercised ONLY inside a rolled-back
//     transaction (B1, B3), so it is never persisted.

const RUN = randomUUID().slice(0, 8);
let bOrgId: string;

async function pq<T extends Record<string, unknown> = Record<string, unknown>>(
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

/** A unique action marker for a given sub-test so seeded rows are addressable
 *  and isolated from other tests/suites on the shared DB. */
function mark(tag: string): string {
  return `retention-spec-${RUN}-${tag}`;
}

/** Seed one committed audit_log row aged `ageMonths` months, returning its id.
 *  Used only for rows we will subsequently prune or (if > 24mo) clean up. */
async function seedAgedRow(orgId: string, ageMonths: number, action: string): Promise<string> {
  const rows = await pq<{ id: string }>(
    `INSERT INTO audit_log (org_id, actor_type, action, created_at)
     VALUES ($1, 'system', $2, now() - make_interval(months => $3))
     RETURNING id`,
    [orgId, action, ageMonths],
  );
  const row = rows[0];
  if (!row) throw new Error('seedAgedRow: insert returned no row');
  return row.id;
}

async function rowExists(id: string): Promise<boolean> {
  const rows = await pq(`SELECT 1 FROM audit_log WHERE id = $1`, [id]);
  return rows.length > 0;
}

beforeAll(async () => {
  const orgs = await pq<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
    [`retention-spec-${RUN}`],
  );
  const org = orgs[0];
  if (!org) throw new Error('beforeAll: org insert returned no row');
  bOrgId = org.id;
});

afterEach(async () => {
  // Remove any of THIS run's committed rows that are still present. They are
  // all > 24mo old (only such rows are ever committed here), so the carve-out
  // permits their deletion — the shared DB is left exactly as we found it.
  await pq(`DELETE FROM audit_log WHERE org_id = $1 AND action LIKE $2`, [
    bOrgId,
    `retention-spec-${RUN}-%`,
  ]);
});

afterAll(async () => {
  // Final sweep + drop the throwaway org (no audit rows reference it now).
  await pq(`DELETE FROM audit_log WHERE org_id = $1 AND action LIKE $2`, [
    bOrgId,
    `retention-spec-${RUN}-%`,
  ]);
  await pq(`DELETE FROM organizations WHERE id = $1`, [bOrgId]);
});

describe('trg_audit_log_immutable — the carved-out boundary is TIGHT (0060)', () => {
  // B1. The whole 3-branch trigger contract, proven inside ONE rolled-back
  //     transaction so NOTHING (not even the deletable >24mo row) persists:
  //       (a) UPDATE of any row                → raises (immutable).
  //       (b) DELETE of a row inside the floor → raises (recent evidence).
  //       (c) DELETE of a row past the floor   → succeeds (prune is allowed).
  it('blocks UPDATE always, blocks recent DELETE, allows >24mo DELETE', async () => {
    const client = await providerPool.connect();
    try {
      await client.query('BEGIN');
      const org = await client.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`retention-trigger-probe-${RUN}`],
      );
      const orgId = (org.rows[0] as { id: string }).id;

      const recent = await client.query(
        `INSERT INTO audit_log (org_id, actor_type, action, created_at)
         VALUES ($1, 'system', 'probe-recent', now() - interval '3 months') RETURNING id`,
        [orgId],
      );
      const recentId = (recent.rows[0] as { id: string }).id;

      const old = await client.query(
        `INSERT INTO audit_log (org_id, actor_type, action, created_at)
         VALUES ($1, 'system', 'probe-old', now() - interval '40 months') RETURNING id`,
        [orgId],
      );
      const oldId = (old.rows[0] as { id: string }).id;

      // (a) UPDATE is unconditionally blocked — even on the >24mo row.
      let updateRejected = false;
      let updateErr: unknown;
      try {
        await client.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [oldId]);
      } catch (e) {
        updateRejected = true;
        updateErr = e;
      }
      expect(updateRejected).toBe(true);
      expect(isAuditLogImmutableError(updateErr)).toBe(true);

      // (b) DELETE of the recent (inside-floor) row is blocked.
      let recentDeleteRejected = false;
      let recentDeleteErr: unknown;
      try {
        await client.query(`DELETE FROM audit_log WHERE id = $1`, [recentId]);
      } catch (e) {
        recentDeleteRejected = true;
        recentDeleteErr = e;
      }
      expect(recentDeleteRejected).toBe(true);
      expect(isAuditLogImmutableError(recentDeleteErr)).toBe(true);

      // (c) DELETE of the >24mo row is PERMITTED — the one mutation the prune
      //     relies on.
      const del = await client.query(`DELETE FROM audit_log WHERE id = $1`, [oldId]);
      expect(del.rowCount).toBe(1);
      expect(await client.query(`SELECT 1 FROM audit_log WHERE id = $1`, [oldId])).toMatchObject({
        rowCount: 0,
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // B1b. TRUNCATE is ALWAYS rejected — the statement-level guard (0060) closes
  //      the owner/BYPASSRLS hole the row-level carve-out cannot cover. We run
  //      inside a rolled-back txn: the BEFORE TRUNCATE trigger raises BEFORE any
  //      row is removed, so no data is ever lost even if it somehow didn't.
  it('blocks TRUNCATE always (statement-level guard fires for the owner)', async () => {
    const client = await providerPool.connect();
    try {
      await client.query('BEGIN');

      let truncateRejected = false;
      let truncateErr: unknown;
      try {
        await client.query('TRUNCATE audit_log');
      } catch (e) {
        truncateRejected = true;
        truncateErr = e;
      }
      expect(truncateRejected).toBe(true);
      expect((truncateErr as { message?: string })?.message).toMatch(
        /audit_log cannot be truncated/,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('pruneAuditLog — REAL DB against the 0060 carve-out (P0.C3)', () => {
  // B2. The prune deletes rows OLDER than the effective window and keeps rows
  //     INSIDE it. Default config → 36mo window: a 40mo row is reaped, a 30mo
  //     row (inside the window, but still > 24mo so cleanable) survives.
  it('deletes rows OLDER than the window; keeps rows inside it (default 36mo)', async () => {
    const oldId = await seedAgedRow(bOrgId, 40, mark('b2-old')); // > 36mo → reaped
    const keptId = await seedAgedRow(bOrgId, 30, mark('b2-kept')); // inside 36mo → kept

    const { log } = makeRecordingLogger();
    const result = await pruneAuditLog(log, {});

    expect(result.effectiveRetentionMonths).toBe(AUDIT_RETENTION_DEFAULT_MONTHS); // 36
    expect(await rowExists(oldId)).toBe(false);
    expect(await rowExists(keptId)).toBe(true);
  });

  // B3. Floor clamp at the DB layer, proven non-destructively. With
  //     AUDIT_RETENTION_MONTHS=12 the EFFECTIVE window is clamped to 24, so a
  //     20-month-old row (which a naive 12mo window would have deleted)
  //     SURVIVES. We run the prune's EXACT cutoff predicate with the clamped
  //     months value inside a rolled-back txn so the sub-floor 20mo row — which
  //     the carve-out would forbid us cleaning up — is never persisted.
  it('a 12-month config is floor-clamped: a 20-month-old row SURVIVES the cutoff', async () => {
    const { log } = makeRecordingLogger();
    const effective = resolveRetentionMonths('12', log);
    expect(effective).toBe(AUDIT_RETENTION_FLOOR_MONTHS); // clamped 12 → 24

    const client = await providerPool.connect();
    try {
      await client.query('BEGIN');
      const org = await client.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`retention-clamp-probe-${RUN}`],
      );
      const orgId = (org.rows[0] as { id: string }).id;

      const survivorId = (
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, action, created_at)
           VALUES ($1, 'system', 'clamp-20mo', now() - interval '20 months') RETURNING id`,
          [orgId],
        )
      ).rows[0] as { id: string };

      // Apply the SAME cutoff the prune computes with the clamped months. Under
      // a 24-month window the 20-month row is NOT eligible, so the predicate
      // matches nothing (and even if it did, the trigger would refuse). The
      // 20mo row therefore survives — the DB mirror of the pure clamp proof.
      const eligible = await client.query(
        `SELECT count(*)::int AS n FROM audit_log
         WHERE org_id = $1 AND created_at < now() - make_interval(months => $2)`,
        [orgId, effective],
      );
      expect((eligible.rows[0] as { n: number }).n).toBe(0);
      expect(
        await client.query(`SELECT 1 FROM audit_log WHERE id = $1`, [survivorId.id]),
      ).toMatchObject({ rowCount: 1 });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  // B4. Batched delete drains a backlog larger than one batch. Seed N > batch
  //     rows, all > the window AND > 24mo (so both prunable and cleanable),
  //     run with a tiny batchSize, assert multiple batches and all gone.
  it('batched delete drains a backlog larger than one batch', async () => {
    const N = 7;
    const batchSize = 3;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      ids.push(await seedAgedRow(bOrgId, 40, mark(`b4-${i}`)));
    }

    const { log } = makeRecordingLogger();
    const result = await pruneAuditLog(log, { batchSize });

    // ceil(7/3) = 3 full-ish batches; the loop stops on the first short batch.
    expect(result.batches).toBeGreaterThanOrEqual(Math.ceil(N / batchSize));
    // All of THIS run's seeded old rows are gone (the prune is global-by-age,
    // but every row it could touch from us was > 36mo).
    for (const id of ids) {
      expect(await rowExists(id)).toBe(false);
    }
  });

  // B5. The completion line carries the effective window + integer counts only
  //     — never row content (audit_log rows carry national_id / ip / state).
  it('emits an evidence log with the effective window + integer counts, no PII', async () => {
    await seedAgedRow(bOrgId, 40, mark('b5-old'));

    const { log, calls } = makeRecordingLogger();
    await pruneAuditLog(log, {});

    const done = calls.find((c) => c.msg === 'audit retention prune complete');
    expect(done).toBeDefined();
    expect(done?.meta).toMatchObject({
      effective_retention_months: AUDIT_RETENTION_DEFAULT_MONTHS,
    });
    // The evidence payload keys are window + integer counters only.
    expect(Object.keys(done?.meta ?? {}).sort()).toEqual(
      ['batches', 'deleted', 'effective_retention_months', 'hit_batch_cap'].sort(),
    );
    expect(typeof done?.meta?.deleted).toBe('number');
    expect(typeof done?.meta?.batches).toBe('number');
  });
});
