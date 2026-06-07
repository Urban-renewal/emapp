/**
 * RESEND signature-request — adversarial, deterministic real-DB spec authored
 * by a SEPARATE test author (does NOT touch the impl).
 *
 * Feature under test: SignatureRequestsService.resend(user, id) —
 *   POST /api/v1/signature-requests/:id/resend
 *   @RequirePermission('signature_requests.send'), throttle 30/min.
 *
 * Behavior (per brief):
 *  - loads the signature_request by id (RLS-scoped → 404 if not in org / missing)
 *  - agent gate: assertDocVisibleForAgent (404 if doc in unassigned project),
 *    then requireAgentCapability('manage_signatures') (403)
 *  - the request MUST be status='pending' else 409 signature_request_not_pending
 *  - re-mints a NEW token (fresh jti + new 7-day expiresAt) via tokenService.sign
 *  - atomically UPDATEs the row's jti+expiresAt WHERE id AND status='pending'
 *  - audits 'signature_request.resend'
 *  - delivers (email+sms+whatsapp) and returns { request, signUrl, delivery }
 *
 * Threat model probed here (the things that would be a real security/biz bug):
 *  - Is the OLD link actually invalidated? (the row's jti MUST change in the DB,
 *    so a public-sign with the old token's jti would fail.)
 *  - Is resend ALLOWED on a signed / cancelled request? (must 409, jti unchanged.)
 *  - Is the agent manage_signatures gate enforced BEFORE the UPDATE? (rejected
 *    agent must not mutate jti.)
 *  - Is a foreign-org / unknown id a no-oracle 404 with zero mutation?
 *  - Is expiresAt actually refreshed (~7 days out)?
 *  - Does the signing token leak into a non-deepLink field of the response?
 *
 * Seeding/construction patterns mirror signatures-capability.spec.ts +
 * signature-requests-bulk.spec.ts. The tokenStub returns a FRESH, unique
 * token+jti each call (so "jti changed" is a meaningful assertion). A
 * JWT-shaped token prefix makes the "no raw token leak" assertion real.
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let foreignOrg: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;
let docAssigned: string;
let docUnassigned: string;
let foreignDoc: string;
let ownerId: string;
let foreignOwnerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000c1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000c2';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** A deterministic JWT-SHAPED string so the "no raw token leak" assertion is
 *  real. Each call returns a FRESH token + a FRESH jti — exactly like the real
 *  tokenService — so asserting "the row's jti changed after resend" is
 *  meaningful (a buggy impl that re-uses the old jti would be caught), and the
 *  new expiry is ~7 days out (the real contract). */
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.RESENDSPECTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-resend-${mintCount}-${randomUUID()}`,
      // ~7 days out, like the real SignatureTokenService.
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
} as never;

// Working email + sms stubs that report 'sent' (owners are seeded WITH an
// email + phone, so both channels are "available").
const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agent(): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

async function setCap(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_signatures}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

async function seedDoc(orgId: string, projectId: string, mgrId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'd.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, mgrId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

function natId(): string {
  return String(Math.floor(100000000 + Math.random() * 899999999));
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `owner-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Pre-create a signature_request directly (bypasses the service) at a chosen
 *  status, so we can drive resend against pending / signed / cancelled rows
 *  independently of create. Returns the row id. */
async function seedRequest(
  orgId: string,
  documentId: string,
  owner: string,
  status: 'pending' | 'signed' | 'cancelled',
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now() + interval '2 days', $6) RETURNING id`,
      [orgId, documentId, owner, 'jti-seed-' + randomUUID(), status, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Read the (jti, expires_at, status) for a request via providerPool
 *  (BYPASSRLS) so assertions are independent of any org context — this is the
 *  ground-truth oracle for "did the OLD link actually die / clock restart". */
async function readRow(
  id: string,
): Promise<{ jti: string; expiresAt: Date; status: string } | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ jti: string; expires_at: Date; status: string }>(
      `SELECT jti, expires_at, status FROM signature_requests WHERE id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { jti: row.jti, expiresAt: new Date(row.expires_at), status: row.status };
  } finally {
    c.release();
  }
}

/** Did an audit row land for this resend? targetId is the request id. */
async function countResendAudits(targetId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'signature_request.resend' AND target_id = $1`,
      [targetId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `resend-sig-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  agentId = await seedAgent(org.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerId });
  docAssigned = await seedDoc(org.id, assignedProjectId, managerId);
  docUnassigned = await seedDoc(org.id, unassignedProjectId, managerId);
  ownerId = await seedOwner(org.id);

  // Foreign org + its own doc/owner (cross-org IDOR target).
  const ftag = `resend-foreign-${Date.now()}`;
  foreignOrg = await createTestOrg(ftag, ftag);
  foreignDoc = await seedDoc(foreignOrg.id, foreignOrg.projects[0]!.id, foreignOrg.users[0]!.id);
  foreignOwnerId = await seedOwner(foreignOrg.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('resend — happy path (pending → refreshed link)', () => {
  it('RS-1) pending → returns {request, signUrl, delivery}; jti CHANGED, expiry refreshed ~7d, status still pending', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const before = await readRow(id);
    expect(before).not.toBeNull();
    expect(before!.status).toBe('pending');

    const res = await svc.resend(manager(), id);

    // Wire shape mirrors create().
    expect(res.request).toBeDefined();
    expect(res.request.id).toBe(id);
    expect(res.request.status).toBe('pending');
    expect(res.signUrl).toContain('/sign/');
    expect(res.signUrl).toContain(FAKE_JWT_PREFIX); // the freshly-minted token
    expect(res.delivery).toBeDefined();

    const after = await readRow(id);
    expect(after).not.toBeNull();
    // CRITICAL: the OLD link is dead — the persisted jti must DIFFER.
    expect(after!.jti).not.toBe(before!.jti);
    // The clock restarted — new expiry is strictly later than the seeded one
    // (seed was now()+2d; refresh is ~now()+7d) AND ~7 days out (within 5 min).
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    const expectedExpiry = Date.now() + SEVEN_DAYS_MS;
    expect(Math.abs(after!.expiresAt.getTime() - expectedExpiry)).toBeLessThan(5 * 60 * 1000);
    // Status unchanged — resend does NOT advance the state machine.
    expect(after!.status).toBe('pending');

    // An audit row for the resend landed.
    expect(await countResendAudits(id)).toBe(1);
  }, 30_000);

  it('RS-2) the OLD jti is gone from the DB after resend (old token would fail public-sign)', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const before = await readRow(id);
    const oldJti = before!.jti;

    await svc.resend(manager(), id);

    const after = await readRow(id);
    // Public-sign matches on the row's stored jti. If it's no longer the old
    // value, a holder of the OLD token (carrying oldJti) can never match → the
    // old link is invalidated. This is the core single-use/rotation guarantee.
    expect(after!.jti).not.toBe(oldJti);
    // And it's exactly the value the (single) mint produced — i.e. it actually
    // wrote a NEW jti, not just cleared/garbled the old one.
    expect(after!.jti).toMatch(/^jti-resend-/);
  }, 30_000);

  it('RS-3) two resends in a row → jti rotates each time (monotonic invalidation)', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const j0 = (await readRow(id))!.jti;

    await svc.resend(manager(), id);
    const j1 = (await readRow(id))!.jti;
    await svc.resend(manager(), id);
    const j2 = (await readRow(id))!.jti;

    expect(j1).not.toBe(j0);
    expect(j2).not.toBe(j1);
    expect(j2).not.toBe(j0);
  }, 30_000);

  it('RS-4) delivery report present: email + sms = sent, whatsapp ready', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const res = await svc.resend(manager(), id);
    expect(res.delivery.email.status).toBe('sent');
    expect(res.delivery.sms.status).toBe('sent');
    expect(res.delivery.whatsapp.status).toBe('ready');
  }, 30_000);

  it('RS-5) raw signing token does NOT leak outside the whatsapp deepLink', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const res = await svc.resend(manager(), id);

    // The wire `request` must never carry the token, jti, or a /sign/ url.
    const requestJson = JSON.stringify(res.request);
    expect(requestJson).not.toContain(FAKE_JWT_PREFIX);
    expect(requestJson).not.toContain('/sign/');
    expect(requestJson.toLowerCase()).not.toContain('jti');

    // signUrl legitimately carries the token (it's the primary deliverable to
    // the manager — same contract as create()). But the delivery report must
    // only surface it inside the whatsapp deepLink, nowhere else.
    const deepLink = res.delivery.whatsapp.deepLink ?? '';
    const deliveryWithoutDeepLink = JSON.stringify(res.delivery).replace(deepLink, '');
    expect(deliveryWithoutDeepLink).not.toContain(FAKE_JWT_PREFIX);
    expect(res.delivery.email.to ?? '').not.toContain(FAKE_JWT_PREFIX);
    expect(res.delivery.email.to ?? '').not.toContain('/sign/');
  }, 30_000);
});

describe('resend — state machine (only pending is resendable)', () => {
  it('RS-6) a SIGNED request → 409 signature_request_not_pending, jti UNCHANGED', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'signed');
    const before = await readRow(id);

    await expect(svc.resend(manager(), id)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.resend(manager(), id)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_not_pending' } },
    });

    const after = await readRow(id);
    // No mutation — the signed row's link/clock are untouched.
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('signed');
    expect(await countResendAudits(id)).toBe(0);
  }, 30_000);

  it('RS-7) a CANCELLED request → 409 signature_request_not_pending, jti UNCHANGED', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerId, 'cancelled');
    const before = await readRow(id);

    await expect(svc.resend(manager(), id)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_not_pending' } },
    });

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('cancelled');
    expect(await countResendAudits(id)).toBe(0);
  }, 30_000);
});

describe('resend — not found / cross-org IDOR (no oracle)', () => {
  it('RS-8) unknown random id → 404', async () => {
    await expect(svc.resend(manager(), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  }, 30_000);

  it('RS-9) a foreign-org request id → 404 (no oracle), jti UNCHANGED', async () => {
    // Seed a pending request fully inside the foreign org.
    const foreignReq = await seedRequest(foreignOrg.id, foreignDoc, foreignOwnerId, 'pending');
    const before = await readRow(foreignReq);

    await expect(svc.resend(manager(), foreignReq)).rejects.toBeInstanceOf(NotFoundException);

    const after = await readRow(foreignReq);
    // The local manager could not even SEE it (RLS) → zero mutation.
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('pending');
  }, 30_000);
});

describe('resend — agent authz (D.46: gate BEFORE the update)', () => {
  it('RS-10) agent WITHOUT manage_signatures (assigned doc) → 403, jti UNCHANGED', async () => {
    await setCap(false);
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const before = await readRow(id);

    await expect(svc.resend(agent(), id)).rejects.toBeInstanceOf(ForbiddenException);

    const after = await readRow(id);
    // The capability gate must fire BEFORE the UPDATE — no link rotation on a
    // rejected agent (else a capability-less agent could still invalidate a
    // resident's live link = a DoS / griefing primitive).
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(await countResendAudits(id)).toBe(0);
  }, 30_000);

  it('RS-11) agent WITH manage_signatures on an ASSIGNED doc → works, jti CHANGED', async () => {
    await setCap(true);
    const id = await seedRequest(org.id, docAssigned, ownerId, 'pending');
    const before = await readRow(id);

    const res = await svc.resend(agent(), id);
    expect(res.request.id).toBe(id);
    expect(res.request.status).toBe('pending');

    const after = await readRow(id);
    expect(after!.jti).not.toBe(before!.jti);
    expect(await countResendAudits(id)).toBe(1);
    await setCap(false);
  }, 30_000);

  it('RS-12) agent WITH cap but request doc in an UNASSIGNED project → 404, jti UNCHANGED', async () => {
    await setCap(true);
    const id = await seedRequest(org.id, docUnassigned, ownerId, 'pending');
    const before = await readRow(id);

    await expect(svc.resend(agent(), id)).rejects.toBeInstanceOf(NotFoundException);

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(await countResendAudits(id)).toBe(0);
    await setCap(false);
  }, 30_000);
});

describe('resend — atomic guard (status=pending in the UPDATE WHERE)', () => {
  it('RS-13) the signed/cancelled 409s prove the WHERE status=pending guard; a re-resend of a signed row never mutates', async () => {
    // This is the testable surface of the atomic race: the UPDATE is guarded by
    // status='pending', so a request that left pending (signed/cancelled) can
    // never have its link rotated — exercised directly by RS-6 + RS-7. Here we
    // additionally prove idempotent rejection: resending a signed row twice
    // leaves it byte-identical.
    const id = await seedRequest(org.id, docAssigned, ownerId, 'signed');
    const before = await readRow(id);
    await expect(svc.resend(manager(), id)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.resend(manager(), id)).rejects.toBeInstanceOf(ConflictException);
    const after = await readRow(id);
    expect(after).toEqual(before);
  }, 30_000);
});
