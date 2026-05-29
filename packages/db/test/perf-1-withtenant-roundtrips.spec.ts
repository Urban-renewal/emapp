import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';
import { env } from '../src/env';
import { projects } from '../src/schema/projects';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

/**
 * PERF-1 — withTenant round-trip OVERHEAD gate (FINDINGS-REGISTER PERF, D.51).
 *
 * Locks the 4–6 → 3 round-trip optimization as a PERMANENT CI regression gate,
 * and pins the security invariant that makes 3 the floor. The pre-existing T1.7
 * guard asserts a wall-clock MEDIAN (ms) — a metric a *caching plaster* would
 * also satisfy (D.51 §2). This test instead asserts the MECHANISM: how many
 * network round-trips withTenant spends on transaction/session OVERHEAD.
 *
 * The current wrapper collapses session setup to three overhead statements:
 *   1. `BEGIN; SET LOCAL ROLE app_user`   (simple protocol — one round-trip)
 *   2. `SELECT set_config(...)` for all GUCs (extended protocol, PARAMETER-BOUND)
 *   …the caller's own query…
 *   3. `COMMIT`
 * → 3 OVERHEAD round-trips (everything that is NOT the caller's query). That is
 * the SAFE FLOOR under two hard constraints that forbid going lower:
 *
 *   - spec §10.3: the PII encryption key MUST be parameter-bound (never in
 *     query text / logs / errors). Parameters require the extended protocol,
 *     which carries exactly one statement — so the GUC set_config cannot be
 *     merged into the multi-statement `BEGIN; SET ROLE` round-trip.
 *   - Neon transaction-pooler (DATABASE_URL is the `-pooler` endpoint): only
 *     tx-local GUCs are safe — a session-level SET leaks the key across pooled
 *     checkouts (a real PII-key leak; caught by with-provider-encryption #5) —
 *     and the transaction MUST be COMMITted (it cannot be left open on a pooled
 *     backend for the next checkout to inherit).
 *
 * Going to ≤2 would require inlining the key into the SQL text (relaxing §10.3)
 * — explicitly REJECTED (do not trade security for one round-trip). This gate
 * therefore pins BOTH directions:
 *   - overhead ≤ 3  → blocks a perf regression back to the un-collapsed 4–6.
 *   - key never in query text → blocks an unsafe "optimization" that inlines
 *     the key to shave the round-trip.
 *
 * A round-trip == one client.query() call (node-postgres flushes each as one
 * request/response; a multi-statement simple query is ONE round-trip). No cache
 * can pass this: it counts statements on the real withTenant path regardless of
 * how fast they return.
 *
 * DO NOT mark these `it`s `concurrent`: the recorder monkey-patches the shared
 * pool.connect and toggles a process-global `recording` flag, so overlapping
 * tests would interleave the query log.
 */
describe('PERF-1 — withTenant round-trip overhead gate', () => {
  let org: TestOrg;

  // ── round-trip recorder ──────────────────────────────────────────
  // Wrap pool.connect so every checked-out client's `query` is logged while
  // `recording` is on.
  const queryLog: string[] = [];
  let recording = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realConnect = (pool.connect as any).bind(pool);

  function queryText(arg: unknown): string {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object' && 'text' in arg) {
      return String((arg as { text: unknown }).text ?? '');
    }
    return '';
  }

  beforeAll(async () => {
    await setupTestDatabase();
    org = await createTestOrg(`PERF1-Org-${Date.now()}`, `perf1-org-${Date.now()}`);

    // One warm call before installing the recorder (drizzle/connection warm-up;
    // round-trip count is deterministic regardless, this just keeps the
    // measured call clean).
    await withTenant(org.id, async (tx) => tx.select().from(projects));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).connect = async (...args: unknown[]) => {
      const client = await realConnect(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(client as any).__perf1Recorder) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realQuery = (client as any).query.bind(client);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).query = (cfg: unknown, ...rest: unknown[]) => {
          if (recording) queryLog.push(queryText(cfg));
          return realQuery(cfg, ...rest);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).__perf1Recorder = true;
      }
      return client;
    };
  });

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).connect = realConnect;
    await pool.end();
  });

  // Overhead = every statement that is NOT the caller's own fn query
  // (transaction control + role + GUC setup).
  const OVERHEAD_RE = /\bbegin\b|\bcommit\b|\brollback\b|set\s+local\s+role|set\s+role|set_config/i;

  it('issues ≤3 overhead round-trips for a single-statement read (4–6→3 locked)', async () => {
    queryLog.length = 0;
    recording = true;
    const rows = await withTenant(org.id, async (tx) => tx.select().from(projects));
    recording = false;

    const overhead = queryLog.filter((t) => OVERHEAD_RE.test(t));
    // eslint-disable-next-line no-console
    console.warn(
      `[PERF-1] round-trips=${queryLog.length} overhead=${overhead.length} :: ${JSON.stringify(queryLog)}`,
    );

    expect(rows.every((p) => p.orgId === org.id)).toBe(true); // correctness preserved
    expect(
      overhead.length,
      `withTenant overhead round-trips=${overhead.length} (>3 = perf regression): ${JSON.stringify(overhead)}`,
    ).toBeLessThanOrEqual(3);
  });

  it('keeps the encryption key parameter-bound — never in query text (§10.3)', async () => {
    // Guard: this assertion is only meaningful with a real key. If env is unset,
    // `includes(undefined)` coerces to "undefined" and trivially passes — fail
    // loudly instead of silently no-opping the security check.
    expect(
      typeof env.PII_ENCRYPTION_KEY === 'string' && env.PII_ENCRYPTION_KEY.length >= 16,
      'PII_ENCRYPTION_KEY must be a real key for this test to be meaningful',
    ).toBe(true);

    queryLog.length = 0;
    recording = true;
    await withTenant(org.id, async (tx) => tx.select().from(projects));
    recording = false;

    for (const t of queryLog) {
      expect(
        t.includes(env.PII_ENCRYPTION_KEY),
        'encryption key leaked into a query TEXT — it MUST stay parameter-bound (§10.3); ' +
          'do NOT inline it to shave a round-trip',
      ).toBe(false);
    }
  });
});
