/**
 * P4 — "resident #6: the NO-PHONE owner". Adversarial, deterministic real-DB
 * spec authored by a SEPARATE test author (does NOT touch the impl).
 *
 * TWO features under test (one slice):
 *
 * (a) A phone-LESS owner must NOT break a signature send.
 *     - loadOwnerWithPii returns phonePlain:null (the CASE-WHEN handles a NULL
 *       phone_encrypted without raising).
 *     - deliverSignatureLink reports sms {available:false, reason:'no_phone_on_file'}
 *       + whatsapp {available:false, ...} instead of throwing.
 *     - createBulk commits the phone-less owner's request in its isolated
 *       delivery tx and NEVER aborts the batch.
 *
 * (b) NEW endpoint POST /api/v1/signature-requests/:id/link
 *     → SignatureRequestsService.getLink(user, id)
 *     @RequirePermission('signature_requests.send') (controller, coarse) +
 *     requireAgentCapability('manage_signatures') + assertDocVisibleForAgent
 *     (service, fine) + withTenant org scope. Re-mints a fresh token + new
 *     7-day expiry (atomic jti/expiresAt swap WHERE still pending), NO delivery.
 *     Returns { request, signUrl } where signUrl embeds a /sign/<token> BEARER
 *     credential. Signed/cancelled → 409, no token minted.
 *
 * THREAT MODEL probed (the things that would be a real security/biz bug):
 *  - Does an unprivileged role (viewer / capability-less agent) ever obtain the
 *    bearer link?  (the headline: the signUrl is a credential.)
 *  - Does a 404 (foreign-org / unknown id) ever MUTATE a row's jti? (a no-oracle
 *    404 that silently rotates a live link = a cross-org griefing primitive.)
 *  - Is the OLD link actually invalidated on each getLink (jti rotates)?
 *  - Is the freshly-minted token EVER written to a log line?
 *  - Is a signed/cancelled request a 409 with zero mutation?
 *
 * Seeding/construction patterns mirror signature-requests-resend.spec.ts +
 * signature-requests-bulk.spec.ts. The tokenStub returns a FRESH, unique
 * token+jti each call (so "jti changed" is meaningful). A JWT-shaped token
 * prefix makes the "no raw token leak" assertions real.
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
import { ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { SYSTEM_ROLE_BY_KEY } from '../../common/authz/system-roles';
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
let ownerWithPhone: string;
let ownerNoPhone: string;
let foreignOwnerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000d2';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** A deterministic JWT-SHAPED string so the "no raw token leak" assertions are
 *  real. Each call returns a FRESH token + a FRESH jti — exactly like the real
 *  tokenService — so "the row's jti changed after getLink" is meaningful (a
 *  buggy impl that re-uses the old jti would be caught), and the new expiry is
 *  ~7 days out (the real contract). */
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.LINKSPECTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-link-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
} as never;

// Working email + sms stubs that report 'sent'. Whether a channel actually
// fires is decided by deliverSignatureLink from the owner's on-file PII (an
// owner with no phone => sms/whatsapp skipped regardless of these stubs).
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

/** Seed an owner. `withPhone:false` leaves phone_encrypted/phone_hash NULL —
 *  the phone-LESS owner this whole spec is about. encryptOwnerPii is given an
 *  empty phone and we null the columns explicitly to be unambiguous. */
async function seedOwner(orgId: string, withPhone: boolean): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: withPhone ? '0541112222' : undefined,
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
        phoneEncrypted: withPhone ? pii.phoneEncrypted : null,
        phoneHash: withPhone ? pii.phoneHash : null,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Slice-1 #2 recipient-association: tie an owner to a project via a real chain
 *  (building → apartment → active 100%-owner ownership) so the owner is
 *  genuinely associated with any project-scoped document under `projectId`.
 *  Each owner gets its OWN apartment (single owner at 100.00) to satisfy the
 *  per-apartment sum=100 trigger. Runs via providerPool (BYPASSRLS). */
async function associateOwnerWithProject(ownerId: string, projectId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [projectId, `St-${randomUUID()}`],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, randomUUID().slice(0, 8)],
    );
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, 100.00, 'owner')`,
      [a.rows[0]!.id, ownerId],
    );
  } finally {
    c.release();
  }
}

/** Seed an owner AND associate it with `projectId` (for the create()/createBulk
 *  recipient-association gate). */
async function seedAssociatedOwner(
  orgId: string,
  projectId: string,
  withPhone: boolean,
): Promise<string> {
  const id = await seedOwner(orgId, withPhone);
  await associateOwnerWithProject(id, projectId);
  return id;
}

/** Pre-create a signature_request directly (bypasses the service) at a chosen
 *  status, for a chosen owner, so getLink is driven against pending / signed /
 *  cancelled rows independently of create(). Returns the row id. */
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

/** Read (jti, expires_at, status) via providerPool (BYPASSRLS) so assertions
 *  are independent of any org context — the ground-truth oracle for "did the
 *  OLD link die / clock restart / status hold / NO mutation". */
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

async function countLinkAudits(targetId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'signature_request.link_retrieve' AND target_id = $1`,
      [targetId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

async function countRows(documentId: string, ownerId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signature_requests WHERE document_id = $1 AND owner_id = $2`,
      [documentId, ownerId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `link-sig-${Date.now()}`;
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
  ownerWithPhone = await seedOwner(org.id, true);
  ownerNoPhone = await seedOwner(org.id, false);

  // Foreign org + its own doc/owner (cross-org IDOR target).
  const ftag = `link-foreign-${Date.now()}`;
  foreignOrg = await createTestOrg(ftag, ftag);
  foreignDoc = await seedDoc(foreignOrg.id, foreignOrg.projects[0]!.id, foreignOrg.users[0]!.id);
  foreignOwnerId = await seedOwner(foreignOrg.id, true);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// (a) PHONE-LESS OWNER DOES NOT BREAK A SEND
// ───────────────────────────────────────────────────────────────────────────

describe('(a) phone-less owner — send is graceful, never throws', () => {
  it('LINK-1) bulk MIX [phoneOwner, noPhoneOwner] → BOTH created, batch NOT aborted; phone-less SMS unavailable (no_phone_on_file), phoned delivers', async () => {
    const phoned = await seedAssociatedOwner(org.id, assignedProjectId, true);
    const noPhone = await seedAssociatedOwner(org.id, assignedProjectId, false);

    const res = await svc.createBulk(manager(), {
      documentId: docAssigned,
      ownerIds: [noPhone, phoned], // no-phone FIRST so a throw would poison the phoned sibling
    });

    // The batch survived: BOTH owners committed a request.
    expect(res.summary).toEqual({ created: 2, skipped: 0, failed: 0 });
    expect(await countRows(docAssigned, noPhone)).toBe(1);
    expect(await countRows(docAssigned, phoned)).toBe(1);

    const noPhoneRes = res.results.find((r) => r.ownerId === noPhone)!;
    const phonedRes = res.results.find((r) => r.ownerId === phoned)!;

    // Phone-less owner: request CREATED (committed) but undelivered over SMS.
    expect(noPhoneRes.outcome).toBe('created');
    expect(noPhoneRes.requestId).toBeTruthy();
    expect(noPhoneRes.delivery).toBeDefined();
    expect(noPhoneRes.delivery!.sms.available).toBe(false);
    expect(noPhoneRes.delivery!.sms.reason).toBe('no_phone_on_file');
    // WhatsApp is phone-derived too → unavailable. Email IS available (owner has
    // an email on file), so the link is still deliverable out-of-band by email.
    expect(noPhoneRes.delivery!.whatsapp.available).toBe(false);
    expect(noPhoneRes.delivery!.email.available).toBe(true);

    // Phoned owner: SMS + WhatsApp DID fire (proves the no-phone sibling didn't
    // suppress the working channel — outcome reflects created-AND-delivered).
    expect(phonedRes.outcome).toBe('created');
    expect(phonedRes.delivery!.sms.available).toBe(true);
    expect(phonedRes.delivery!.sms.status).toBe('sent');
    expect(phonedRes.delivery!.whatsapp.available).toBe(true);
  }, 30_000);

  it('LINK-2) individual create to a phone-less owner → request + token created, SMS skipped, NO throw', async () => {
    const noPhone = await seedAssociatedOwner(org.id, assignedProjectId, false);

    const res = await svc.create(manager(), { documentId: docAssigned, ownerId: noPhone });

    // Request row committed + a token minted (signUrl carries it).
    expect(res.request).toBeDefined();
    expect(res.request.ownerId).toBe(noPhone);
    expect(res.request.status).toBe('pending');
    expect(res.signUrl).toContain('/sign/');
    expect(res.signUrl).toContain(FAKE_JWT_PREFIX);
    expect(await countRows(docAssigned, noPhone)).toBe(1);

    // SMS + WhatsApp skipped (no phone); the call did NOT throw.
    expect(res.delivery.sms.available).toBe(false);
    expect(res.delivery.sms.reason).toBe('no_phone_on_file');
    expect(res.delivery.whatsapp.available).toBe(false);
    // Email channel still available (owner has an email).
    expect(res.delivery.email.available).toBe(true);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// (b) THE LINK-RETRIEVAL ENDPOINT — AUTHZ MATRIX + RE-MINT + NO-MUTATION + LEAK
// ───────────────────────────────────────────────────────────────────────────

describe('(b) getLink — manager happy path (atomic re-mint)', () => {
  it('LINK-3) manager on a PENDING request → 200 { request, signUrl=/sign/<token> }; jti CHANGED, expiry refreshed ~7d, status pending, audited', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerNoPhone, 'pending');
    const before = await readRow(id);
    expect(before!.status).toBe('pending');

    const res = await svc.getLink(manager(), id);

    // Wire shape: exactly { request, signUrl } — NO delivery (this is a read,
    // not a send).
    expect(Object.keys(res).sort()).toEqual(['request', 'signUrl']);
    expect(res.request.id).toBe(id);
    expect(res.request.status).toBe('pending');
    expect(res.signUrl).toContain('/sign/');
    expect(res.signUrl).toContain(FAKE_JWT_PREFIX); // freshly minted bearer token

    const after = await readRow(id);
    // CRITICAL (load-bearing): the prior link is DEAD — persisted jti differs,
    // and it's the value a NEW mint produced (not just cleared/garbled).
    expect(after!.jti).not.toBe(before!.jti);
    expect(after!.jti).toMatch(/^jti-link-/);
    // Clock restarted: strictly later than the seeded now()+2d, ~7d out.
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    const expectedExpiry = Date.now() + SEVEN_DAYS_MS;
    expect(Math.abs(after!.expiresAt.getTime() - expectedExpiry)).toBeLessThan(5 * 60 * 1000);
    // Status unchanged — getLink does NOT advance the state machine.
    expect(after!.status).toBe('pending');

    // The link-retrieval was audited (distinct action from resend).
    expect(await countLinkAudits(id)).toBe(1);
  }, 30_000);

  it('LINK-3b) two getLinks in a row → jti rotates each time (the OLD link dies on every pull)', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerWithPhone, 'pending');
    const j0 = (await readRow(id))!.jti;
    await svc.getLink(manager(), id);
    const j1 = (await readRow(id))!.jti;
    await svc.getLink(manager(), id);
    const j2 = (await readRow(id))!.jti;
    expect(j1).not.toBe(j0);
    expect(j2).not.toBe(j1);
    expect(j2).not.toBe(j0);
  }, 30_000);
});

describe('(b) getLink — VIEWER is denied the bearer link (coarse send gate)', () => {
  it('LINK-4a) the system permission catalog: viewer LACKS signature_requests.send (manager HOLDS it)', () => {
    // The Viewer 403 is enforced by the controller @RequirePermission(
    // 'signature_requests.send') + AuthorizationGuard, which denies ANY role
    // whose resolved permission set excludes that permission. Service-level
    // unit tests bypass the guard, so we pin the GROUND TRUTH the guard reads:
    // viewer's catalog set is read-only and does NOT include the send write.
    // If a refactor ever added send to viewer, THIS reddens — the guard would
    // then hand the credential to a read-only role.
    const viewerPerms = SYSTEM_ROLE_BY_KEY.get('viewer')!.permissions;
    const managerPerms = SYSTEM_ROLE_BY_KEY.get('manager')!.permissions;
    expect(managerPerms).toContain('signature_requests.send');
    expect(viewerPerms).not.toContain('signature_requests.send');
    // Sanity: viewer CAN read signature requests (so the deny is specifically
    // on the credential-minting send, not a blanket exclusion).
    expect(viewerPerms).toContain('signature_requests.read');
  });
});

describe('(b) getLink — AGENT authz (D.46: gate BEFORE the mint/update)', () => {
  it('LINK-5a) agent WITHOUT manage_signatures (assigned doc) → 403, jti UNCHANGED, NOT audited', async () => {
    await setCap(false);
    const id = await seedRequest(org.id, docAssigned, ownerWithPhone, 'pending');
    const before = await readRow(id);

    await expect(svc.getLink(agent(), id)).rejects.toBeInstanceOf(ForbiddenException);

    const after = await readRow(id);
    // The capability gate must fire BEFORE the UPDATE — no link rotation on a
    // rejected agent (else a capability-less agent could pull/invalidate a live
    // link = credential leak + griefing primitive).
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(await countLinkAudits(id)).toBe(0);
  }, 30_000);

  it('LINK-5b) agent WITH cap but request doc in an UNASSIGNED project → 404 (D.46 no oracle), jti UNCHANGED', async () => {
    await setCap(true);
    const id = await seedRequest(org.id, docUnassigned, ownerWithPhone, 'pending');
    const before = await readRow(id);

    await expect(svc.getLink(agent(), id)).rejects.toBeInstanceOf(NotFoundException);

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(await countLinkAudits(id)).toBe(0);
    await setCap(false);
  }, 30_000);

  it('LINK-5c) agent WITH manage_signatures on an ASSIGNED doc → 200, jti CHANGED (positive control)', async () => {
    await setCap(true);
    const id = await seedRequest(org.id, docAssigned, ownerWithPhone, 'pending');
    const before = await readRow(id);

    const res = await svc.getLink(agent(), id);
    expect(res.request.id).toBe(id);
    expect(res.signUrl).toContain('/sign/');

    const after = await readRow(id);
    expect(after!.jti).not.toBe(before!.jti);
    expect(await countLinkAudits(id)).toBe(1);
    await setCap(false);
  }, 30_000);
});

describe('(b) getLink — foreign-org / unknown id → 404 with ZERO mutation', () => {
  it('LINK-6a) unknown random id → 404', async () => {
    await expect(svc.getLink(manager(), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  }, 30_000);

  it('LINK-6b) a foreign-org request id → 404 (no oracle), the foreign row jti DID NOT change', async () => {
    const foreignReq = await seedRequest(foreignOrg.id, foreignDoc, foreignOwnerId, 'pending');
    const before = await readRow(foreignReq);

    await expect(svc.getLink(manager(), foreignReq)).rejects.toBeInstanceOf(NotFoundException);

    const after = await readRow(foreignReq);
    // The local manager could not even SEE it (RLS) → ZERO mutation. A 404 that
    // rotated the foreign jti would be a cross-org link-invalidation primitive.
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('pending');
  }, 30_000);
});

describe('(b) getLink — only PENDING yields a link (signed/cancelled 409, no mint)', () => {
  it('LINK-7a) a SIGNED request → 409 signature_request_not_pending, jti UNCHANGED, NOT audited', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerWithPhone, 'signed');
    const before = await readRow(id);

    await expect(svc.getLink(manager(), id)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.getLink(manager(), id)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_not_pending' } },
    });

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('signed');
    expect(await countLinkAudits(id)).toBe(0);
  }, 30_000);

  it('LINK-7b) a CANCELLED request → 409 signature_request_not_pending, jti UNCHANGED', async () => {
    const id = await seedRequest(org.id, docAssigned, ownerWithPhone, 'cancelled');
    const before = await readRow(id);

    await expect(svc.getLink(manager(), id)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_not_pending' } },
    });

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('cancelled');
    expect(await countLinkAudits(id)).toBe(0);
  }, 30_000);
});

describe('(b) getLink — the minted token NEVER reaches a log line', () => {
  it('LINK-8) across a full manager getLink, NO Logger.{error,warn,log,debug,verbose} call contains the token or the /sign/ url', async () => {
    // The freshly minted bearer token only legitimately leaves the service in
    // the returned signUrl. getLink does NO delivery I/O, so nothing should log
    // it. Spy on the NestJS Logger prototype (the service uses `new Logger()`)
    // and capture EVERY logged argument across the call, then assert the raw
    // token + signUrl are absent. This is load-bearing: a stray
    // logger.debug(signUrl) would defeat pino's URL redaction and persist the
    // credential to log storage.
    const logged: string[] = [];
    const capture =
      () =>
      (...args: unknown[]): void => {
        for (const a of args) {
          try {
            logged.push(typeof a === 'string' ? a : JSON.stringify(a));
          } catch {
            logged.push(String(a));
          }
        }
      };
    for (const m of ['error', 'warn', 'log', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, m).mockImplementation(capture());
    }

    const id = await seedRequest(org.id, docAssigned, ownerWithPhone, 'pending');
    const res = await svc.getLink(manager(), id);

    // The token DID come back in the signUrl (so the test isn't vacuous — the
    // token genuinely exists and is JWT-shaped).
    expect(res.signUrl).toContain(FAKE_JWT_PREFIX);
    const token = res.signUrl.split('/sign/')[1]!;
    expect(token).toContain(FAKE_JWT_PREFIX);

    // ...but it must appear in ZERO captured log lines, and no log line carries
    // a /sign/ URL either.
    const blob = logged.join('\n');
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(FAKE_JWT_PREFIX);
    expect(blob).not.toContain('/sign/');
  }, 30_000);
});
