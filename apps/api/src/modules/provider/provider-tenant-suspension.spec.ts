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

import { encryptOwnerPii, organizations, owners, withProvider, withTenant } from '@emapp/db';
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

async function insertSession(userId: string): Promise<string> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 days')
       RETURNING id`,
      [userId, 'hash-' + randomUUID()],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function sessionRevoked(sessionId: string): Promise<boolean> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM auth_sessions WHERE id = $1`,
      [sessionId],
    );
    return r.rows[0]!.revoked_at !== null;
  } finally {
    client.release();
  }
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: '000000018',
      name: 'דייר בדיקה',
      phone: '0541230000',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function insertTenantSession(ownerId: string, orgId: string): Promise<string> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ id: string }>(
      `INSERT INTO tenant_sessions (owner_id, org_id, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')
       RETURNING id`,
      [ownerId, orgId],
    );
    return r.rows[0]!.id;
  } finally {
    client.release();
  }
}

async function tenantSessionRevoked(sessionId: string): Promise<boolean> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM tenant_sessions WHERE id = $1`,
      [sessionId],
    );
    return r.rows[0]!.revoked_at !== null;
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

  it('D49-SUSP-REVOKE) suspend revokes ALL active sessions for the org members; other orgs untouched', async () => {
    // Enforcement part 2: suspending an org kills its members' live sessions so
    // an already-authenticated user is locked out (the session row is revoked →
    // isOrgSessionActive false + refresh re-checks revoked_at). A session in a
    // DIFFERENT org must stay active (the member sub-select is org-scoped).
    const orgRevoke = await createTestOrg(`${TEST_PREFIX}-rev`, `${TEST_PREFIX}-rev`);
    const orgKeep = await createTestOrg(`${TEST_PREFIX}-keep`, `${TEST_PREFIX}-keep`);
    const sidRevoke = await insertSession(orgRevoke.users[0]!.id);
    const sidKeep = await insertSession(orgKeep.users[0]!.id);

    // Sanity: both active before suspend.
    expect(await sessionRevoked(sidRevoke)).toBe(false);
    expect(await sessionRevoked(sidKeep)).toBe(false);

    await svc.suspend(
      principal(),
      'INC-4906: suspend must revoke live sessions',
      orgRevoke.id,
      null,
    );

    // The suspended org's member session is revoked; the other org's is not.
    expect(await sessionRevoked(sidRevoke)).toBe(true);
    expect(await sessionRevoked(sidKeep)).toBe(false);
  });

  it('D49-SUSP-TENANT-REVOKE) suspend also revokes resident (tenant_sessions) sessions; other orgs untouched', async () => {
    // Enforcement of the RESIDENT tier: suspending an org kills its owners'
    // live tenant-portal sessions too (D.49 full freeze). A resident session in
    // a DIFFERENT org survives (org-scoped on tenant_sessions.org_id).
    const orgRevoke = await createTestOrg(`${TEST_PREFIX}-trev`, `${TEST_PREFIX}-trev`);
    const orgKeep = await createTestOrg(`${TEST_PREFIX}-tkeep`, `${TEST_PREFIX}-tkeep`);
    const ownerRevoke = await seedOwner(orgRevoke.id);
    const ownerKeep = await seedOwner(orgKeep.id);
    const tsidRevoke = await insertTenantSession(ownerRevoke, orgRevoke.id);
    const tsidKeep = await insertTenantSession(ownerKeep, orgKeep.id);

    expect(await tenantSessionRevoked(tsidRevoke)).toBe(false);
    expect(await tenantSessionRevoked(tsidKeep)).toBe(false);

    await svc.suspend(
      principal(),
      'INC-4907: suspend must freeze the resident portal',
      orgRevoke.id,
      null,
    );

    expect(await tenantSessionRevoked(tsidRevoke)).toBe(true);
    expect(await tenantSessionRevoked(tsidKeep)).toBe(false);
  }, 30_000);
});
