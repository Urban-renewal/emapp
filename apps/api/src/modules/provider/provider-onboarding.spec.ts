/**
 * D.45 — Provider onboarding service integration spec.
 *
 * Mechanism evidence (D.51 — criteria a plaster cannot pass):
 *   (a) AUDIT-FIRST — onboarding writes a `provider.tenant.created` row to
 *       `provider_audit_log` with `target_record_id = <new orgId>` and
 *       metadata `{ endpoint:'onboard', orgId, slug }` — and NO email/PII
 *       in the audit (D45-ONB-AUDIT).
 *   (b) STRUCTURE — the org is created, a password-less first-manager user
 *       exists, and a PENDING (acceptedAt=null) manager membership links
 *       them; the invite email is sent to the manager with a token; the
 *       token is returned in test env only (D45-ONB-CREATE).
 *   (c) IDEMPOTENT-ON-EMAIL — onboarding with an email that already exists
 *       reuses the user (no duplicate user row) and adds a new membership
 *       (D45-ONB-EXISTING).
 *   (d) The token is a real invite token — verifiable with iss=emapp /
 *       aud=emapp-invite, so the existing PUBLIC /auth/accept-invite would
 *       accept it (D45-ONB-TOKEN).
 */
import { serverEnv } from '@emapp/config';
import { FakeEmailProvider } from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderOnboardingService } from './provider-onboarding.service';

let provider: TestProviderUser;
let jwt: JwtService;
let email: FakeEmailProvider;
let svc: ProviderOnboardingService;
const PREFIX = 'd45-onb-' + Date.now();

function principal(): ProviderPrincipal {
  return { sub: provider.id, ip: '203.0.113.45', userAgent: 'D45-onboarding-spec/1.0' };
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
      `SELECT action_type, target_record_id, metadata FROM provider_audit_log
       WHERE provider_user_id = $1 AND reason = $2 ORDER BY started_at ASC`,
      [provider.id, reasonMarker],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

async function orgRow(orgId: string) {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ id: string; name: string; slug: string }>(
      `SELECT id, name, slug FROM organizations WHERE id = $1`,
      [orgId],
    );
    return r.rows[0];
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
  email = new FakeEmailProvider();
  svc = new ProviderOnboardingService(jwt, email);
}, 90_000);

afterAll(() => {
  /* pools are shared singletons; global teardown closes them */
});

describe('D.45 ProviderOnboardingService — create org + first-manager invite', () => {
  it('D45-ONB-CREATE) creates org + password-less manager + pending membership; sends invite; returns token (test env)', async () => {
    email.reset();
    const REASON = 'ONB-1: pilot customer onboarding';
    const managerEmail = `${PREFIX}-1-mgr@example.test`;

    const result = await svc.onboard(principal(), REASON, {
      orgName: 'Pilot Renewal Co',
      managerName: 'דנה מנהלת',
      managerEmail,
    });

    // Org persisted with the returned id + a server-generated slug.
    expect(result.orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.slug.length).toBeGreaterThan(0);
    const org = await orgRow(result.orgId);
    expect(org?.name).toBe('Pilot Renewal Co');
    expect(org?.slug).toBe(result.slug);

    // First-manager user exists, password-less (invite will activate it).
    const usersFound = await providerSelectUsers(managerEmail);
    const u = usersFound[0];
    expect(u).toBeDefined();
    expect(u?.passwordHash).toBeNull();

    // Pending manager membership links user→org.
    const m = await providerSelectMembership(u!.id, result.orgId);
    expect(m?.role).toBe('manager');
    expect(m?.acceptedAt).toBeNull();
    expect(m?.isPrimary).toBe(true);

    // Invite email sent to the manager, with the kind tag.
    expect(email.sent.length).toBe(1);
    expect(email.lastSent()?.to).toBe(managerEmail);
    expect(email.lastSent()?.tags?.['kind']).toBe('org_invite');

    // Token returned in test env (NODE_ENV=test → EXPOSE_INVITE_TOKEN).
    expect(result.inviteToken).toBeTruthy();
  });

  it('D45-ONB-AUDIT) writes provider.tenant.created audit row with NO email/PII in metadata', async () => {
    email.reset();
    const REASON = 'ONB-2: audit-shape check';
    const result = await svc.onboard(principal(), REASON, {
      orgName: 'Audit Org',
      managerName: 'Manager Two',
      managerEmail: `${PREFIX}-2-mgr@example.test`,
    });
    const rows = await auditRowsFor(REASON);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_type).toBe('provider.tenant.created');
    expect(rows[0]!.target_record_id).toBe(result.orgId);
    const meta = rows[0]!.metadata as { endpoint?: string; orgId?: string; slug?: string };
    expect(meta.endpoint).toBe('onboard');
    expect(meta.orgId).toBe(result.orgId);
    // PII discipline: the manager email must NOT appear anywhere in the audit row.
    const blob = JSON.stringify(rows[0]);
    expect(blob).not.toContain(`${PREFIX}-2-mgr@example.test`);
  });

  it('D45-ONB-EXISTING) an already-existing user email is REUSED (no duplicate user), new membership added', async () => {
    email.reset();
    const sharedEmail = `${PREFIX}-shared@example.test`;
    const r1 = await svc.onboard(principal(), 'ONB-3a: first org for shared manager', {
      orgName: 'Shared Mgr Org A',
      managerName: 'Shared Manager',
      managerEmail: sharedEmail,
    });
    const r2 = await svc.onboard(principal(), 'ONB-3b: second org for shared manager', {
      orgName: 'Shared Mgr Org B',
      managerName: 'Shared Manager',
      managerEmail: sharedEmail,
    });

    const allUsers = await providerSelectUsers(sharedEmail);
    expect(allUsers.length).toBe(1); // reused — not duplicated
    const uid = allUsers[0]!.id;
    const mA = await providerSelectMembership(uid, r1.orgId);
    const mB = await providerSelectMembership(uid, r2.orgId);
    expect(mA?.role).toBe('manager');
    expect(mB?.role).toBe('manager');
    // Reused user is no longer primary on the second org.
    expect(mB?.isPrimary).toBe(false);
  });

  it('D45-ONB-TOKEN) the returned invite token verifies with iss=emapp / aud=emapp-invite', async () => {
    const result = await svc.onboard(principal(), 'ONB-4: token verification check', {
      orgName: 'Token Org',
      managerName: 'Token Manager',
      managerEmail: `${PREFIX}-4-mgr@example.test`,
    });
    const claims = jwt.verify<{ sub: string; orgId: string; mid: string; typ: string }>(
      result.inviteToken!,
      { issuer: 'emapp', audience: 'emapp-invite', algorithms: ['HS256'] },
    );
    expect(claims.typ).toBe('invite');
    expect(claims.orgId).toBe(result.orgId);
    expect(claims.sub).toBeTruthy();
    expect(claims.mid).toBeTruthy();
  });
});

// ── small DB helpers (BYPASSRLS provider pool) ──
async function providerSelectUsers(
  emailAddr: string,
): Promise<Array<{ id: string; passwordHash: string | null }>> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ id: string; password_hash: string | null }>(
      `SELECT id, password_hash FROM users WHERE email = $1`,
      [emailAddr],
    );
    return r.rows.map((row) => ({ id: row.id, passwordHash: row.password_hash }));
  } finally {
    client.release();
  }
}

async function providerSelectMembership(
  userId: string,
  orgId: string,
): Promise<{ role: string; acceptedAt: Date | null; isPrimary: boolean } | undefined> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{ role: string; accepted_at: Date | null; is_primary: boolean }>(
      `SELECT role, accepted_at, is_primary FROM memberships WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId],
    );
    const row = r.rows[0];
    return row
      ? { role: row.role, acceptedAt: row.accepted_at, isPrimary: row.is_primary }
      : undefined;
  } finally {
    client.release();
  }
}
