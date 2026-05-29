import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

/**
 * PERF-3 — projects + documents list pagination must be served by a composite
 * partial index, not an in-RAM Sort (FINDINGS-REGISTER PERF, D.51).
 *
 * Both list endpoints page with `WHERE archived_at IS NULL ORDER BY created_at
 * DESC, id DESC` (org-scoped by RLS) — see projects.service.ts:198-208 and
 * documents.service.ts:485-488. Without `(org_id, created_at DESC, id DESC)
 * WHERE archived_at IS NULL` the planner does a whole-org Sort at scale
 * (owners + tasks + memberships already have this index — migration 0037).
 *
 * The gate asserts the MECHANISM (not a symptom): an index-ordered scan with
 * NO Sort node, plus the index existing as a partial composite. Sort-node
 * elimination is plaster-proof — a query cache, a latency tweak, or a
 * non-index change cannot remove a Sort node from the plan.
 *
 * `enable_seqscan` is disabled inside the measuring transaction so the
 * assertion is deterministic regardless of how many rows the test org holds.
 * Seq scan AND bitmap scan are both disabled in the measuring tx: a bitmap
 * scan uses the index but does not preserve order (still needs a Sort), so on
 * a tiny table the planner would pick bitmap+Sort and mask the result. With
 * both off, the only sort-free path is a plain ordered Index Scan — which
 * exists ONLY when an index covers this exact ordering. WITH the index →
 * ordered Index Scan, no Sort; WITHOUT it → Seq Scan + Sort (Sort node
 * present). That isolates "does an index serve this exact ordering" from
 * planner row-count thresholds, so the gate never flakes on a small table.
 */
describe('PERF-3 — projects/documents list composite index', () => {
  let org: TestOrg;

  beforeAll(async () => {
    await setupTestDatabase();
    org = await createTestOrg(`PERF3-Org-${Date.now()}`, `perf3-org-${Date.now()}`);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Targets the base (Manager, no-filter) list shape — the primary perf path.
  // The agent-scoped variants (projects inner-join on project_assignments;
  // documents EXISTS-subquery scoping) add filters on top of the same
  // archived_at IS NULL + created_at/id ordering, so the same index applies.
  async function listPlan(table: 'projects' | 'documents'): Promise<string> {
    return withTenant(org.id, async (tx) => {
      // Disable seq scan AND bitmap scan so the planner must reveal whether an
      // index can serve the ORDER BY without a Sort. Bitmap scans use the index
      // but lose row order (they'd still need a Sort), so on a tiny table the
      // planner would otherwise pick bitmap+Sort and mask the result. With both
      // off, the only sort-free path is a plain ordered Index Scan — which
      // exists only when an index covers this exact ordering. tx-local — both
      // revert on COMMIT.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      const res = await tx.execute(
        sql`EXPLAIN SELECT id FROM ${sql.identifier(table)}
              WHERE archived_at IS NULL
              ORDER BY created_at DESC, id DESC
              LIMIT 25`,
      );
      return (res.rows as Array<Record<string, unknown>>)
        .map((r) => String(Object.values(r)[0]))
        .join('\n');
    });
  }

  it('projects list is index-ordered (idx_projects_org_created), no Sort node', async () => {
    const plan = await listPlan('projects');
    expect(plan, `plan:\n${plan}`).toContain('idx_projects_org_created');
    expect(
      /\bSort\b/i.test(plan),
      `unexpected Sort node — index not serving ORDER BY:\n${plan}`,
    ).toBe(false);
  });

  it('documents list is index-ordered (idx_documents_org_created), no Sort node', async () => {
    const plan = await listPlan('documents');
    expect(plan, `plan:\n${plan}`).toContain('idx_documents_org_created');
    expect(
      /\bSort\b/i.test(plan),
      `unexpected Sort node — index not serving ORDER BY:\n${plan}`,
    ).toBe(false);
  });

  it('both indexes exist as partial composite (org_id, created_at DESC, id DESC) WHERE archived_at IS NULL', async () => {
    const res = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('idx_projects_org_created', 'idx_documents_org_created')`,
    );
    const byName = Object.fromEntries(res.rows.map((r) => [r.indexname, r.indexdef]));
    for (const name of ['idx_projects_org_created', 'idx_documents_org_created']) {
      const def = byName[name];
      expect(def, `${name} must exist`).toBeTruthy();
      // Partial on the soft-delete column — keeps the index small and matches
      // the list predicate (the same shape as 0037's tasks/memberships indexes).
      expect(def, `${name} must be partial on archived_at IS NULL: ${def}`).toMatch(
        /archived_at IS NULL/i,
      );
      expect(def, `${name} must order (created_at DESC, id DESC): ${def}`).toMatch(
        /created_at DESC, id DESC/i,
      );
    }
  });
});
