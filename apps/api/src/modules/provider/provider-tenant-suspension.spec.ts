/**
 * D.49 — Provider suspend/reactivate service integration spec.
 *
 * Mechanical evidence for the three D.49 hard controls (D.51 — these are
 * mechanism criteria a plaster cannot pass):
 *
 *   (a) AUDIT-FIRST / SA-7 — the `provider_audit_log` row is committed in
 *       an autonomous tx BEFORE the work runs. A forced failure in the
 *       suspend work tx leaves the audit row PERSISTED and the org
 *       UNCHANGED (D49-SUSP-SA7). The 404 path also writes its audit row
 *       (D49-SUSP-404).
 *   (b) ACCESS_REASON REQUIRED — the write path refuses an empty/invalid
 *       reason at the service boundary (withProvider re-validation,
 *       defense-in-depth behind the @AccessReason 400 pinned in
 *       access-reason.decorator.spec.ts) → D49-SUSP-REASON.
 *   (c) the `write` ProviderAction enforcement lives in policy.spec.ts +
 *       provider-authorization*.guard.spec.ts.
 *
 * Plus the functional contract: suspend persists `suspended_at` /
 * `suspended_reason` (distinct from `archived_at`), reactivate clears
 * them, re-suspend is idempotent on the timestamp, and the audit rows
 * carry the dedicated action labels.
 */
import { randomUUID } from 'node:crypto';

import { organizations, withProvider } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestOrg,
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderTenantSuspensionService } from './provider-tenant-suspension.service';

let provider: TestProviderUser;
let svc: ProviderTenantSuspensionService;
const TEST_PREFIX = 'd49-susp-' + Date.now();

function principal(): ProviderPrincipal {
  return { sub: provider.id, ip: '203.0.113.49', userAgent: 'D49-suspension-spec/1.0' };
}

interface OrgState {
  suspended_at: Date | null;
  suspended_reason: string | null;
  archived_at: Date | null;
}

async function orgState(orgId: string): Promise<OrgState> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<OrgState>(
      `SELECT suspended_at, suspended_reason, archived_at FROM organizations WHERE id = $1`,
      [orgId],
    );
    return r.rows[0]!;
  } finally {
    client.release();
  }
}

async function auditRowsFor(
  reasonMarker: string,
): Promise<
  Array<{ action_type: string; target_record_id: string | null; metadata: Record<string, unknown> }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{
      action_type: string;
      target_record_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action_type, target_record_id, metadata
       FROM provider_audit_log
       WHERE provider_user_id = $1 AND reason = $2
       ORDER BY started_at ASC`,
      [provider.id, reasonMarker],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderTenantSuspensionService();
}, 90_000);

afterAll(() => {
  /* pools are shared singletons; global teardown closes them */
});

describe('D.49 ProviderTenantSuspensionService — suspend/reactivate', () => {
  it('D49-SUSP-1) suspend persists suspended_at + note; returns state; writes audit row', async () => {
    const org = await createTestOrg(`${TEST_PREFIX}-1`, `${TEST_PREFIX}-1`);
    const REASON = 'INC-4901: suspending for non-payment investigation';
    const NOTE = 'Billing hold — invoice 90d overdue';

    const before = await orgState(org.id);
    expect(before.suspended_at).toBeNull();

    const state = await svc.suspend(principal(), REASON, org.id, NOTE);
    expect(state.suspended).toBe(true);
    expect(state.suspendedAt).not.toBeNull();
    expect(state.suspendedReason).toBe(NOTE);

    const after = await orgState(org.id);
    expect(after.suspended_at).not.toBeNull();
    expect(after.suspended_reason).toBe(NOTE);
    // suspend is NOT archive — archived_at must stay untouched.
    expect(after.archived_at).toBeNull();

    const rows = await auditRowsFor(REASON);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_type).toBe('provider.tenant.suspended');
    expect(rows[0]!.target_record_id).toBe(org.id);
    expect((rows[0]!.metadata as { endpoint?: string }).endpoint).toBe('suspend');
  });

  it('D49-SUSP-2) reactivate clears both columns; returns state; writes reactivated audit row', async () => {
    const org = await createTestOrg(`${TEST_PREFIX}-2`, `${TEST_PREFIX}-2`);
    await svc.suspend(principal(), 'INC-4902: temp suspend before reactivate test', org.id, 'note');

    const REASON = 'INC-4902: reactivating after payment cleared';
    const state = await svc.reactivate(principal(), REASON, org.id);
    expect(state.suspended).toBe(false);
    expect(state.suspendedAt).toBeNull();
    expect(state.suspendedReason).toBeNull();

    const after = await orgState(org.id);
    expect(after.suspended_at).toBeNull();
    expect(after.suspended_reason).toBeNull();

    const rows = await auditRowsFor(REASON);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_type).toBe('provider.tenant.reactivated');
    expect(rows[0]!.target_record_id).toBe(org.id);
  });

  it('D49-SUSP-3) re-suspend is idempotent on the timestamp (COALESCE keeps original freeze time)', async () => {
    const org = await createTestOrg(`${TEST_PREFIX}-3`, `${TEST_PREFIX}-3`);
    const first = await svc.suspend(principal(), 'INC-4903: first suspend', org.id, 'first note');
    const firstAt = first.suspendedAt;
    expect(firstAt).not.toBeNull();

    const second = await svc.suspend(
      principal(),
      'INC-4903: second suspend updates note only',
      org.id,
      'second note',
    );
    // Original freeze time preserved; note refreshed.
    expect(second.suspendedAt).toEqual(firstAt);
    expect(second.suspendedReason).toBe('second note');
  });

  it('D49-SUSP-404) missing org → NotFoundException; audit row STILL written (audit-first)', async () => {
    const ghostId = randomUUID();
    const REASON = 'INC-4904: suspend against non-existent tenant — ' + randomUUID();
    await expect(svc.suspend(principal(), REASON, ghostId, null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const rows = await auditRowsFor(REASON);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_type).toBe('provider.tenant.suspended');
    expect(rows[0]!.target_record_id).toBe(ghostId);
  });

  it('D49-SUSP-REASON) write with an empty/invalid access_reason is REJECTED (no audit, no mutation)', async () => {
    const org = await createTestOrg(`${TEST_PREFIX}-r`, `${TEST_PREFIX}-r`);
    // withProvider re-validates the reason → the suspend never runs.
    await expect(svc.suspend(principal(), '   ', org.id, 'should not persist')).rejects.toThrow(
      /reason_required/,
    );
    const after = await orgState(org.id);
    expect(after.suspended_at).toBeNull();
    expect(after.suspended_reason).toBeNull();
  });

  it('D49-SUSP-SA7) audit-first: a forced failure in the suspend work tx leaves the audit row PERSISTED and the org UNCHANGED', async () => {
    // The service delegates to withProvider with action
    // 'provider.tenant.suspended'. We reproduce that exact call but make
    // the work fn perform the real UPDATE and THEN throw — proving the
    // work tx rolls back (org NOT suspended) while the autonomous audit
    // row (committed before the work) survives. This is the SA-7
    // (ISO A.12.4.3) guarantee for the write path.
    const org = await createTestOrg(`${TEST_PREFIX}-sa7`, `${TEST_PREFIX}-sa7`);
    const REASON = 'INC-4905: SA-7 rollback proof — ' + randomUUID();

    await expect(
      withProvider(
        provider.id,
        REASON,
        async (tx) => {
          await tx
            .update(organizations)
            .set({ suspendedAt: sql`now()`, suspendedReason: 'about to be rolled back' })
            .where(eq(organizations.id, org.id));
          throw new Error('synthetic work-tx failure after the UPDATE');
        },
        {
          targetTable: 'organizations',
          targetRecordId: org.id,
          action: 'provider.tenant.suspended',
          metadata: { endpoint: 'suspend', tenantId: org.id },
        },
      ),
    ).rejects.toThrow(/synthetic work-tx failure/);

    // Work rolled back — org is NOT suspended.
    const after = await orgState(org.id);
    expect(after.suspended_at).toBeNull();
    expect(after.suspended_reason).toBeNull();

    // Audit row persisted — autonomous tx, committed before the work.
    const rows = await auditRowsFor(REASON);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_type).toBe('provider.tenant.suspended');
    expect(rows[0]!.target_record_id).toBe(org.id);
  });
});
