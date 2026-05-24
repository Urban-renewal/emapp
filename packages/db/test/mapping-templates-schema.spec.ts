/**
 * Phase 6 S7 — mapping_templates schema invariants (migration 0028).
 *
 * Pinned by D.34 layer-2 architecture: these tests are the contract
 * the worker's future TemplateResolver + the wizard's POST/PATCH
 * endpoints (S8) will rely on.
 *
 *   1. RLS — Org A cannot see Org B's templates
 *   2. UNIQUE (org, fingerprint) WHERE archived_at IS NULL
 *   3. CHECK — source must be 'manual'|'agent'|'system'
 *   4. CHECK — agent rows require confidence ∈ [0,100]; others NULL
 *   5. CHECK — approved_by and approved_at move together
 *   6. GRANT — app_user can SELECT/INSERT/UPDATE but NOT DELETE
 *   7. Soft-delete unblocks re-creation for the same fingerprint
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool, providerPool } from '../src/client';
import { mappingTemplates } from '../src/schema/mapping-templates';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

let orgA: TestOrg;
let orgB: TestOrg;

function baseRow(o: TestOrg, fp: string) {
  return {
    orgId: o.id,
    fingerprint: fp,
    name: 'Test Template',
    mapping: {
      columns: { national_id: 0, phone: 1, name: 2, apartment_number: 3, building_address: 4 },
      headers: ['ת.ז.', 'טלפון', 'שם', 'דירה', 'כתובת'],
    },
    source: 'manual' as const,
    createdBy: o.users[0]!.id,
    approvedBy: o.users[0]!.id,
    approvedAt: new Date(),
  };
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`MTA-${ts}`, `mta-${ts}`);
  orgB = await createTestOrg(`MTB-${ts}`, `mtb-${ts}`);
});

afterAll(async () => {
  /* pool teardown */
});

async function expectPgError(
  promise: Promise<unknown>,
  expected: { code?: string; constraint?: string; messageMatches?: RegExp },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected promise to reject').toBeDefined();
  let cur: unknown = caught;
  let depth = 0;
  while (cur && depth < 8) {
    const pg = cur as { code?: string; constraint?: string; message?: string };
    if (expected.code && pg.code === expected.code) return;
    if (expected.constraint && pg.constraint === expected.constraint) return;
    if (expected.messageMatches && pg.message && expected.messageMatches.test(pg.message)) return;
    cur = (cur as { cause?: unknown })?.cause;
    depth += 1;
  }
  throw new Error(
    `pg error did not match. Looked for ${JSON.stringify(expected)}. ` +
      `Got: ${caught instanceof Error ? caught.message : String(caught)}`,
  );
}

describe('Phase 6 S7 · mapping_templates — schema invariants', () => {
  it('1) RLS — a row created in Org A is invisible to Org B', async () => {
    const fp = `fp-rls-${Date.now()}`;
    await withTenant(orgA.id, async (tx) => tx.insert(mappingTemplates).values(baseRow(orgA, fp)));
    const fromB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: mappingTemplates.id })
        .from(mappingTemplates)
        .where(eq(mappingTemplates.fingerprint, fp)),
    );
    expect(fromB).toHaveLength(0);
  });

  it('2) UNIQUE — second insert for same (org, fingerprint) active rejected', async () => {
    const fp = `fp-unique-${Date.now()}`;
    await withTenant(orgA.id, async (tx) => tx.insert(mappingTemplates).values(baseRow(orgA, fp)));
    await expectPgError(
      withTenant(orgA.id, async (tx) => tx.insert(mappingTemplates).values(baseRow(orgA, fp))),
      { code: '23505', constraint: 'mapping_templates_org_fp_active' },
    );
  });

  it('3) CHECK — source must be enum (manual|agent|system)', async () => {
    await expectPgError(
      withTenant(orgA.id, async (tx) =>
        tx.insert(mappingTemplates).values({
          ...baseRow(orgA, `fp-src-${Date.now()}`),
          source: 'unknown' as never,
        }),
      ),
      { code: '23514', constraint: 'mapping_templates_source_valid' },
    );
  });

  it('4) CHECK — agent source requires confidence in [0,100]', async () => {
    // agent with NULL confidence — rejected.
    await expectPgError(
      withTenant(orgA.id, async (tx) =>
        tx.insert(mappingTemplates).values({
          ...baseRow(orgA, `fp-agent-${Date.now()}`),
          source: 'agent',
        }),
      ),
      { code: '23514', constraint: 'mapping_templates_confidence_range' },
    );
    // agent with confidence=85 — accepted.
    await withTenant(orgA.id, async (tx) =>
      tx.insert(mappingTemplates).values({
        ...baseRow(orgA, `fp-agent-ok-${Date.now()}`),
        source: 'agent',
        confidence: '85',
      }),
    );
  });

  it('4b) CHECK — manual source must have NULL confidence', async () => {
    await expectPgError(
      withTenant(orgA.id, async (tx) =>
        tx.insert(mappingTemplates).values({
          ...baseRow(orgA, `fp-manual-c-${Date.now()}`),
          source: 'manual',
          confidence: '99',
        }),
      ),
      { code: '23514', constraint: 'mapping_templates_confidence_range' },
    );
  });

  it('5) CHECK — approved_by + approved_at move together', async () => {
    // approved_by set but approved_at NULL — rejected.
    await expectPgError(
      withTenant(orgA.id, async (tx) =>
        tx.insert(mappingTemplates).values({
          ...baseRow(orgA, `fp-appr-${Date.now()}`),
          approvedBy: orgA.users[0]!.id,
          approvedAt: null,
        }),
      ),
      { code: '23514', constraint: 'mapping_templates_approval_paired' },
    );
  });

  it('6) GRANT — app_user has no DELETE on mapping_templates', async () => {
    await expectPgError(
      withTenant(orgA.id, async (tx) => {
        await tx.execute(sql`DELETE FROM mapping_templates WHERE id = gen_random_uuid()`);
      }),
      { code: '42501', messageMatches: /permission denied/i },
    );
  });

  it('7) Soft-delete — archiving a template unblocks re-creation for same fingerprint', async () => {
    const fp = `fp-archive-${Date.now()}`;
    // First template.
    await withTenant(orgA.id, async (tx) => tx.insert(mappingTemplates).values(baseRow(orgA, fp)));
    // Archive it via the provider pool (app_user can UPDATE, RLS still applies for org check).
    await withTenant(orgA.id, async (tx) =>
      tx
        .update(mappingTemplates)
        .set({ archivedAt: new Date() })
        .where(eq(mappingTemplates.fingerprint, fp)),
    );
    // A fresh row for the same fingerprint now allowed (partial unique).
    await withTenant(orgA.id, async (tx) => tx.insert(mappingTemplates).values(baseRow(orgA, fp)));
    const active = await withTenant(orgA.id, async (tx) =>
      tx
        .select({ id: mappingTemplates.id, archivedAt: mappingTemplates.archivedAt })
        .from(mappingTemplates)
        .where(eq(mappingTemplates.fingerprint, fp)),
    );
    expect(active).toHaveLength(2);
    expect(active.filter((r) => r.archivedAt === null)).toHaveLength(1);
  });

  it('8) `awaiting_mapping` is now a valid import_jobs.status (migration 0027)', async () => {
    // Definitive check: read the constraint definition and assert
    // it contains the new state string.
    const client = await providerPool.connect();
    try {
      const res = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'import_jobs_status_valid'`,
      );
      expect(res.rows[0]?.def).toBeDefined();
      expect(res.rows[0]!.def).toContain('awaiting_mapping');
    } finally {
      client.release();
    }
    void pool; // pool import used by setup; touch to avoid unused
  });
});
