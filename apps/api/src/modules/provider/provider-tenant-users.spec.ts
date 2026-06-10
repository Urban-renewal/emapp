/**
 * P4 / PLAN-provider-console §3 Tier-1 #1 — `GET /provider/tenants/:id/users`
 * (org users management) service integration spec.
 *
 * Service-level: instantiates `ProviderTenantUsersService` directly, seeds
 * two orgs with mixed memberships (active / invited / revoked, a custom
 * role assignment, distinct Hebrew + ASCII names + emails), then asserts:
 *   - PII MASKING: name is `•••••••XX` (last-2 only); email is masked
 *     `a•••@domain` (first char + domain). Full name + full local-part of
 *     the email NEVER appear in the response JSON. No national_id / phone
 *     anywhere (not even a column).
 *   - status derivation (active / invited / revoked).
 *   - role + custom roleKeys surfacing.
 *   - cross-tenant isolation (Org A list excludes Org B members).
 *   - cursor pagination (cap + has_more + next-page walk).
 *   - the read is AUDITED (action 'provider.tenant.users.viewed',
 *     target_table='memberships', target_record_id=orgId, metadata.reason).
 *   - 404 on a random org id (audit row STILL written by the wrapper).
 *
 * Mirrors `provider-tenant-detail.spec.ts` posture (real DB, provider pool
 * for BYPASSRLS seeding, audit-row inspection).
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, users } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestOrg,
  createTestProviderUser,
  type TestOrg,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderTenantUsersService } from './provider-tenant-users.service';

let provider: TestProviderUser;
let svc: ProviderTenantUsersService;
const TEST_PREFIX = 'p4-users-' + Date.now();
let orgA: TestOrg;
let orgB: TestOrg;
let auditStartMarker: Date;

// Distinctive PII strings we will scan the response JSON for — these must
// NEVER appear verbatim (only their masked tails are allowed).
const SECRET_FULL_NAME = 'אברהם-יצחק לוינשטיין';
const SECRET_EMAIL_LOCAL = `avraham.yitzhak.secret.${TEST_PREFIX}`;
const SECRET_EMAIL = `${SECRET_EMAIL_LOCAL}@levin-corp.example`;

function principal(): ProviderPrincipal {
  return { sub: provider.id, ip: '203.0.113.7', userAgent: 'P4-users-spec/1.0' };
}

/** Resolve a seeded system role id by key (org_id IS NULL). */
async function systemRoleId(key: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE org_id IS NULL AND is_system = true AND key = $1`,
      [key],
    );
    if (!r.rows[0]) throw new Error(`system role not seeded: ${key}`);
    return r.rows[0].id;
  } finally {
    c.release();
  }
}

async function seedMember(input: {
  orgId: string;
  name: string;
  email: string;
  role: 'agent' | 'manager' | 'viewer';
  status: 'active' | 'invited' | 'revoked';
  withCustomRoleAssignment?: boolean;
}): Promise<{ userId: string; membershipId: string }> {
  const [u] = await db
    .insert(users)
    .values({ email: input.email, name: input.name, passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  const userId = u!.id;

  const [m] = await db
    .insert(memberships)
    .values({
      userId,
      orgId: input.orgId,
      role: input.role,
      acceptedAt: input.status === 'invited' ? null : new Date(),
      revokedAt: input.status === 'revoked' ? new Date() : null,
    })
    .returning({ id: memberships.id });

  if (input.withCustomRoleAssignment) {
    const roleId = await systemRoleId(input.role);
    const c = await providerPool.connect();
    try {
      await c.query(
        `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
         VALUES ($1, $2, 'org', $3, now())
         ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
        [userId, roleId, input.orgId],
      );
    } finally {
      c.release();
    }
  }
  return { userId, membershipId: m!.id };
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderTenantUsersService();
  auditStartMarker = new Date();

  // createTestOrg already creates a bootstrap manager membership (org.users[0]).
  orgA = await createTestOrg(`${TEST_PREFIX}-A`, `${TEST_PREFIX}-a`);
  orgB = await createTestOrg(`${TEST_PREFIX}-B`, `${TEST_PREFIX}-b`);

  // Org A members: one with the secret PII (active, custom role assignment),
  // one invited, one revoked.
  await seedMember({
    orgId: orgA.id,
    name: SECRET_FULL_NAME,
    email: SECRET_EMAIL,
    role: 'agent',
    status: 'active',
    withCustomRoleAssignment: true,
  });
  await seedMember({
    orgId: orgA.id,
    name: 'Invited Person',
    email: `invited-${TEST_PREFIX}@acme.example`,
    role: 'viewer',
    status: 'invited',
  });
  await seedMember({
    orgId: orgA.id,
    name: 'Revoked Person',
    email: `revoked-${TEST_PREFIX}@acme.example`,
    role: 'agent',
    status: 'revoked',
  });

  // Org B member with a DISTINCT email so cross-tenant isolation is provable.
  await seedMember({
    orgId: orgB.id,
    name: 'אורית כהן',
    email: `orgb-only-${TEST_PREFIX}@beta.example`,
    role: 'manager',
    status: 'active',
  });
}, 90_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

async function ourAuditRows(): Promise<
  Array<{
    reason: string;
    action_type: string;
    metadata: Record<string, unknown>;
    target_table: string | null;
    target_record_id: string | null;
  }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{
      reason: string;
      action_type: string;
      metadata: Record<string, unknown>;
      target_table: string | null;
      target_record_id: string | null;
    }>(
      `SELECT reason, action_type, metadata, target_table, target_record_id
       FROM provider_audit_log
       WHERE provider_user_id = $1 AND started_at >= $2
       ORDER BY started_at ASC`,
      [provider.id, auditStartMarker.toISOString()],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

describe('GET /provider/tenants/:id/users — P4 org users service integration', () => {
  it('P4-users-1) name + email are MASKED; full PII never appears in the response JSON', async () => {
    const res = await svc.list(principal(), 'TKT-4100: PII mask scan', orgA.id, { limit: 25 });
    const blob = JSON.stringify(res);

    // Full secret PII must NOT appear verbatim anywhere.
    expect(blob).not.toContain(SECRET_FULL_NAME);
    expect(blob).not.toContain(SECRET_EMAIL_LOCAL);
    expect(blob).not.toContain(SECRET_EMAIL);

    for (const m of res.data) {
      // name masked: leading bullets + short visible tail.
      expect(m.nameMasked.startsWith('•••••••')).toBe(true);
      // email masked: first char + '•••@' + domain; the local-part is NOT
      // exposed beyond the first character.
      expect(m.emailMasked).toMatch(/^.•••@.+/);
      expect(m.emailMasked.includes('@')).toBe(true);
    }
  });

  it('P4-users-2) no national_id / phone anywhere on the wire (no such field, no 9-digit run)', async () => {
    const res = await svc.list(principal(), 'TKT-4100: nid/phone absence', orgA.id, { limit: 25 });
    const blob = JSON.stringify(res);
    // Members carry no national_id/phone at this surface — assert the fields
    // are simply not present, and no NID-shaped 9-digit run leaks.
    expect(blob).not.toMatch(/national_id|nationalId|"phone"/i);
    expect(blob).not.toMatch(/\b\d{9}\b/);
  });

  it('P4-users-3) status derivation: active / invited / revoked all surface', async () => {
    const res = await svc.list(principal(), 'TKT-4100: status derivation', orgA.id, { limit: 25 });
    const statuses = res.data.map((m) => m.status);
    expect(statuses).toContain('active');
    expect(statuses).toContain('invited');
    expect(statuses).toContain('revoked');
  });

  it('P4-users-4) role + custom roleKeys surface; isPrimary set for the bootstrap manager', async () => {
    const res = await svc.list(principal(), 'TKT-4100: roles', orgA.id, { limit: 25 });
    // The custom-role-assignment agent carries a non-empty roleKeys array.
    const withKeys = res.data.find((m) => m.roleKeys.length > 0);
    expect(withKeys).toBeDefined();
    expect(withKeys!.roleKeys).toContain('agent');
    // The bootstrap manager membership is primary.
    const primary = res.data.find((m) => m.isPrimary);
    expect(primary).toBeDefined();
  });

  it('P4-users-5) cross-tenant isolation: Org A list excludes Org B members', async () => {
    const resA = await svc.list(principal(), 'TKT-4100: isolation A', orgA.id, { limit: 25 });
    const blobA = JSON.stringify(resA);
    // Org B's distinct email tail must never appear in Org A's masked list.
    expect(blobA).not.toContain('beta.example');
  });

  it('P4-users-6) audit row: action=provider.tenant.users.viewed, target=memberships/orgId, reason present', async () => {
    const REASON = 'audit content — ' + randomUUID();
    await svc.list(principal(), REASON, orgA.id, { limit: 25 });
    const row = (await ourAuditRows()).find((r) => r.reason === REASON);
    expect(row).toBeDefined();
    expect(row!.action_type).toBe('provider.tenant.users.viewed');
    expect(row!.target_table).toBe('memberships');
    expect(row!.target_record_id).toBe(orgA.id);
    const md = row!.metadata as { endpoint?: string; tenantId?: string; reason?: string };
    expect(md.endpoint).toBe('users');
    expect(md.tenantId).toBe(orgA.id);
    expect(md.reason).toBe(REASON);
  });

  it('P4-users-7) not-found random uuid → 404 tenant_not_found; audit row STILL written', async () => {
    const ghostId = randomUUID();
    const REASON = 'not-found — ' + randomUUID();
    await expect(svc.list(principal(), REASON, ghostId, { limit: 25 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const ours = (await ourAuditRows()).filter((r) => r.reason === REASON);
    expect(ours.length).toBe(1);
    expect(ours[0]!.target_record_id).toBe(ghostId);
  });

  it('P4-users-8) pagination: limit caps the page and has_more + cursor walk works', async () => {
    const first = await svc.list(principal(), 'TKT-4100: page 1', orgA.id, { limit: 2 });
    expect(first.data.length).toBe(2);
    expect(first.page.has_more).toBe(true);
    expect(first.page.cursor).toBeTruthy();

    const second = await svc.list(principal(), 'TKT-4100: page 2', orgA.id, {
      limit: 2,
      cursor: first.page.cursor!,
    });
    // No overlap between page 1 and page 2 ids.
    const firstIds = new Set(first.data.map((m) => m.id));
    for (const m of second.data) expect(firstIds.has(m.id)).toBe(false);
  });
});
