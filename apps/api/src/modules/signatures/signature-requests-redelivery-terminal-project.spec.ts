/**
 * TERMINAL-PROJECT GATE on the RE-DELIVERY paths (red-team round-4 LOW follow-up)
 * — adversarial, deterministic real-DB spec. The CREATE-path gate (PR #595,
 * covered by signature-requests-terminal-project.spec.ts) blocks MINTING a NEW
 * signing link against a document whose parent PROJECT is terminal (`cancelled` /
 * `completed`, per the canonical `PROJECT_TERMINAL_STATUSES`) or archived.
 *
 * THE GAP this pins closed: a request created while a project was ACTIVE could
 * still be RE-DELIVERED after the project went terminal/archived — the
 * re-delivery paths re-minted a fresh 7-day token + (some) decrypted owner PII
 * with NO terminal-project check:
 *   - resend(user, id)                  — single, re-mint + deliver a PENDING req
 *   - remindProjectPending(user, pid)   — bulk, chase every live-pending of a project
 *   - reissueExpired / reissueAndDeliver — revive an EXPIRED req + governed re-send
 *   - getLink(user, id)                 — re-mint a BEARER link for out-of-band delivery
 *   - resendForOwner(org, owner, req)   — resident self-resend of THEIR pending link
 *
 * (getLink + resendForOwner are the SAME-CLASS bearer-link re-mint paths an
 * independent red-team surfaced — cancelling a project does NOT flip a pending
 * request to expired, so both could still re-mint a live link for a dead deal.)
 *
 * The fix reuses the SAME canonical private `assertProjectActiveForDoc` seam the
 * create path uses (single source of truth — no divergent re-implementation),
 * placed BEFORE the re-mint AND before any owner-PII decrypt on each path.
 *
 * Error POSTURE per path (matched to each path's existing convention):
 *   - resend (single)  → throws `signature_request_project_terminal` (409), like create.
 *   - reissue (single) → throws `signature_request_project_terminal` (409), like create.
 *   - remind (bulk, scoped to ONE project) → throws `signature_request_project_terminal`
 *     (409) for the WHOLE batch, matching that path's whole-batch reject convention
 *     (404 not-visible / 403 capability / 503 kill-switch all fail the whole call).
 *   - getLink (manager send-tier) → throws `signature_request_project_terminal` (409),
 *     like resend (the controller pins it to the send path).
 *   - resendForOwner (resident own-record) → no-oracle 404 (`NotFoundException`),
 *     matching that path's existing posture (not-found / not-this-owner / not-pending
 *     ALL → 404): a terminal/archived deal reads as "gone", never a status oracle.
 *
 * Coverage (per path): cancelled AND archived → blocked (no re-mint / no delivery);
 * gathering_signatures / approved (non-terminal, non-archived) → succeeds (happy
 * path preserved). Seeding mirrors signature-requests-terminal-project.spec.ts;
 * project status/archive are driven via providerPool (BYPASSRLS).
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { PROJECT_TERMINAL_STATUSES } from '@emapp/shared-types';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.REDELIVERYTERMINALTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-redeliv-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
} as never;

// Both providers REPORT 'sent' — so a happy-path remind actually delivers via the
// (non-consent-gated) deliverResendPayload and counts as reminded.
const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function natId(): string {
  return String(Math.floor(100000000 + Math.random() * 899999999));
}

/** Seed a fresh project in a chosen status; driven via providerPool so we can
 *  place it in ANY status (incl. terminal) / archived regardless of the
 *  create-form transition gate. */
async function seedProject(
  orgId: string,
  status: string,
  opts: { archived?: boolean } = {},
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, status, archived_at, created_by)
       VALUES ($1, $2, 'tama38_1', $3, ${opts.archived ? `now()` : `NULL`}, $4)
       RETURNING id`,
      [orgId, `proj-${randomUUID().slice(0, 8)}`, status, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedBuilding(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, 'TLV') RETURNING id`,
      [projectId, `St-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedApartment(buildingId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [buildingId, randomUUID().slice(0, 8)],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
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
        email: `owner-${randomUUID()}@test.local`,
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

/** Active `owner` ownership at 100% (keeps the D.25 sum trigger satisfied). */
async function seedOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, 100.00, 'owner')`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}

/** Seed a FINALISED, project-scoped document. */
async function seedDoc(orgId: string, projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'd.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now())
       RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Pre-create a signature_request in a chosen state with a chosen expiry.
 *  `pending` + future expiry  → resend / remind live-pending input.
 *  `expired` + past expiry     → reissue input. */
async function seedRequest(
  orgId: string,
  documentId: string,
  ownerId: string,
  status: 'pending' | 'expired',
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const expiresAt =
      status === 'pending' ? `now() + interval '7 days'` : `now() - interval '1 day'`;
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, ${expiresAt}, $6) RETURNING id`,
      [orgId, documentId, ownerId, 'jti-seed-' + randomUUID(), status, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** The request's stored token id (jti) + expiry — to PROVE a blocked re-delivery
 *  did NOT re-mint a fresh token (the defense-in-depth claim). */
async function readReqState(id: string): Promise<{ status: string; jti: string; expiresAt: Date }> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ status: string; jti: string; expires_at: Date }>(
      `SELECT status, jti, expires_at FROM signature_requests WHERE id = $1`,
      [id],
    );
    const row = r.rows[0]!;
    return { status: row.status, jti: row.jti, expiresAt: row.expires_at };
  } finally {
    c.release();
  }
}

/** A full project→building→apartment→owner→ownership→doc→request fixture in
 *  `status`/archived, with the request pre-seeded in `reqStatus`. */
async function fixture(
  status: string,
  reqStatus: 'pending' | 'expired',
  opts: { archived?: boolean } = {},
): Promise<{ projectId: string; doc: string; ownerId: string; reqId: string }> {
  const projectId = await seedProject(org.id, status, opts);
  const building = await seedBuilding(projectId);
  const apartment = await seedApartment(building);
  const ownerId = await seedOwner(org.id);
  await seedOwnership(apartment, ownerId);
  const doc = await seedDoc(org.id, projectId);
  const reqId = await seedRequest(org.id, doc, ownerId, reqStatus);
  return { projectId, doc, ownerId, reqId };
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `sig-redeliv-terminal-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// Sanity: the canonical source the gate reuses is exactly the two terminal
// statuses (binds the spec's intent to the single source of truth).
describe('canonical PROJECT_TERMINAL_STATUSES (re-delivery gate reuses it)', () => {
  it('contains cancelled and completed (and only those today)', () => {
    expect([...PROJECT_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// RESEND (single) — re-mint + deliver a PENDING request
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — resend (single)', () => {
  it('REJECTS resend against a CANCELLED project → signature_request_project_terminal, NO re-mint', async () => {
    const { reqId } = await fixture('cancelled', 'pending');
    const before = await readReqState(reqId);
    await expect(svc.resend(manager(), reqId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    const after = await readReqState(reqId);
    // Defense-in-depth: the token was NOT re-minted (same jti) — a dead-deal
    // re-send must not refresh the 7-day link.
    expect(after.jti).toBe(before.jti);
    expect(after.status).toBe('pending');
  }, 30_000);

  it('REJECTS resend against an ARCHIVED project → signature_request_project_terminal, NO re-mint', async () => {
    const { reqId } = await fixture('gathering_signatures', 'pending', { archived: true });
    const before = await readReqState(reqId);
    await expect(svc.resend(manager(), reqId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    const after = await readReqState(reqId);
    expect(after.jti).toBe(before.jti);
  }, 30_000);

  it('ALLOWS resend against a GATHERING_SIGNATURES project → re-minted (happy path preserved)', async () => {
    const { reqId } = await fixture('gathering_signatures', 'pending');
    const before = await readReqState(reqId);
    const res = await svc.resend(manager(), reqId);
    expect(res.request).toBeDefined();
    const after = await readReqState(reqId);
    // The token WAS re-minted (fresh jti) — the link refreshed.
    expect(after.jti).not.toBe(before.jti);
    expect(after.status).toBe('pending');
  }, 30_000);

  it('ALLOWS resend against an APPROVED project → re-minted (happy path preserved)', async () => {
    const { reqId } = await fixture('approved', 'pending');
    const before = await readReqState(reqId);
    const res = await svc.resend(manager(), reqId);
    expect(res.request).toBeDefined();
    const after = await readReqState(reqId);
    expect(after.jti).not.toBe(before.jti);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// REISSUE (single) — revive an EXPIRED request (reissueExpired / reissueAndDeliver)
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — reissue (single)', () => {
  it('REJECTS reissueExpired against a CANCELLED project → signature_request_project_terminal, request STAYS expired', async () => {
    const { reqId } = await fixture('cancelled', 'expired');
    await expect(svc.reissueExpired(manager(), reqId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    // The dead-deal request was NOT revived into the pending pool.
    expect((await readReqState(reqId)).status).toBe('expired');
  }, 30_000);

  it('REJECTS reissueExpired against an ARCHIVED project → signature_request_project_terminal, request STAYS expired', async () => {
    const { reqId } = await fixture('approved', 'expired', { archived: true });
    await expect(svc.reissueExpired(manager(), reqId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect((await readReqState(reqId)).status).toBe('expired');
  }, 30_000);

  it('REJECTS reissueAndDeliver (the proposal executor) against a CANCELLED project — the governed send never fires', async () => {
    const { reqId } = await fixture('cancelled', 'expired');
    // reissueAndDeliver calls reissueExpired FIRST, so the terminal gate throws
    // before the governed-outbound send is even reached.
    await expect(
      svc.reissueAndDeliver(manager(), { signatureRequestId: reqId, proposalId: randomUUID() }),
    ).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect((await readReqState(reqId)).status).toBe('expired');
  }, 30_000);

  it('ALLOWS reissueExpired against a GATHERING_SIGNATURES project → revived to pending (happy path preserved)', async () => {
    const { reqId } = await fixture('gathering_signatures', 'expired');
    const res = await svc.reissueExpired(manager(), reqId);
    expect(res).toBeDefined();
    expect((await readReqState(reqId)).status).toBe('pending');
  }, 30_000);

  it('ALLOWS reissueExpired against an APPROVED project → revived to pending (happy path preserved)', async () => {
    const { reqId } = await fixture('approved', 'expired');
    const res = await svc.reissueExpired(manager(), reqId);
    expect(res).toBeDefined();
    expect((await readReqState(reqId)).status).toBe('pending');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// REMIND (bulk, project-scoped) — chase every live-pending request of a project
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — remindProjectPending (bulk)', () => {
  it('REJECTS the WHOLE remind against a CANCELLED project → signature_request_project_terminal, NO re-mint', async () => {
    const { projectId, reqId } = await fixture('cancelled', 'pending');
    const before = await readReqState(reqId);
    await expect(svc.remindProjectPending(manager(), projectId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    // The whole-batch reject runs BEFORE deriving/re-minting any request.
    expect((await readReqState(reqId)).jti).toBe(before.jti);
  }, 30_000);

  it('REJECTS the WHOLE remind against an ARCHIVED project → signature_request_project_terminal, NO re-mint', async () => {
    const { projectId, reqId } = await fixture('gathering_signatures', 'pending', {
      archived: true,
    });
    const before = await readReqState(reqId);
    await expect(svc.remindProjectPending(manager(), projectId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect((await readReqState(reqId)).jti).toBe(before.jti);
  }, 30_000);

  it('ALLOWS remind against a GATHERING_SIGNATURES project → the live-pending request is reminded (happy path preserved)', async () => {
    const { projectId, reqId } = await fixture('gathering_signatures', 'pending');
    const before = await readReqState(reqId);
    const res = await svc.remindProjectPending(manager(), projectId);
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect(res.reminded).toBeGreaterThanOrEqual(1);
    // The reminded request's token WAS re-minted (link refreshed).
    expect((await readReqState(reqId)).jti).not.toBe(before.jti);
  }, 30_000);

  it('ALLOWS remind against an APPROVED project → the live-pending request is reminded (happy path preserved)', async () => {
    const { projectId, reqId } = await fixture('approved', 'pending');
    const before = await readReqState(reqId);
    const res = await svc.remindProjectPending(manager(), projectId);
    expect(res.total).toBeGreaterThanOrEqual(1);
    expect((await readReqState(reqId)).jti).not.toBe(before.jti);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// getLink (manager send-tier) — re-mint a BEARER signing link for out-of-band
// delivery (same-class re-delivery path the red-team surfaced)
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — getLink (bearer link re-mint)', () => {
  it('REJECTS getLink against a CANCELLED project → signature_request_project_terminal, NO re-mint', async () => {
    const { reqId } = await fixture('cancelled', 'pending');
    const before = await readReqState(reqId);
    await expect(svc.getLink(manager(), reqId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    // No fresh bearer credential was minted for the dead deal.
    expect((await readReqState(reqId)).jti).toBe(before.jti);
  }, 30_000);

  it('REJECTS getLink against an ARCHIVED project → signature_request_project_terminal, NO re-mint', async () => {
    const { reqId } = await fixture('approved', 'pending', { archived: true });
    const before = await readReqState(reqId);
    await expect(svc.getLink(manager(), reqId)).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect((await readReqState(reqId)).jti).toBe(before.jti);
  }, 30_000);

  it('ALLOWS getLink against a GATHERING_SIGNATURES project → fresh link minted (happy path preserved)', async () => {
    const { reqId } = await fixture('gathering_signatures', 'pending');
    const before = await readReqState(reqId);
    const res = await svc.getLink(manager(), reqId);
    expect(res.signUrl).toContain('/sign/');
    // The bearer link WAS re-minted (fresh jti) — the manager can deliver it.
    expect((await readReqState(reqId)).jti).not.toBe(before.jti);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// resendForOwner (resident own-record) — self-resend of THEIR pending link.
// POSTURE: no-oracle 404 (a terminal/archived deal reads as "gone", never a
// status oracle for the resident).
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — resendForOwner (resident self-resend, no-oracle 404)', () => {
  it('REJECTS resendForOwner against a CANCELLED project → 404 (no oracle), NO re-mint', async () => {
    const { ownerId, reqId } = await fixture('cancelled', 'pending');
    const before = await readReqState(reqId);
    await expect(svc.resendForOwner(org.id, ownerId, reqId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Defense-in-depth: no fresh token minted for the dead deal.
    expect((await readReqState(reqId)).jti).toBe(before.jti);
  }, 30_000);

  it('REJECTS resendForOwner against an ARCHIVED project → 404 (no oracle), NO re-mint', async () => {
    const { ownerId, reqId } = await fixture('gathering_signatures', 'pending', { archived: true });
    const before = await readReqState(reqId);
    await expect(svc.resendForOwner(org.id, ownerId, reqId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await readReqState(reqId)).jti).toBe(before.jti);
  }, 30_000);

  it('ALLOWS resendForOwner against a GATHERING_SIGNATURES project → delivered + re-minted (happy path preserved)', async () => {
    const { ownerId, reqId } = await fixture('gathering_signatures', 'pending');
    const before = await readReqState(reqId);
    const delivery = await svc.resendForOwner(org.id, ownerId, reqId);
    // The seeded owner has email+phone, both stubs report 'sent'.
    expect(delivery).toBeDefined();
    // The link WAS re-minted (fresh jti).
    expect((await readReqState(reqId)).jti).not.toBe(before.jti);
  }, 30_000);

  it('ALLOWS resendForOwner against an APPROVED project → re-minted (happy path preserved)', async () => {
    const { ownerId, reqId } = await fixture('approved', 'pending');
    const before = await readReqState(reqId);
    await svc.resendForOwner(org.id, ownerId, reqId);
    expect((await readReqState(reqId)).jti).not.toBe(before.jti);
  }, 30_000);
});
