/**
 * RESIDENT SELF-RESEND (B-RESIDENT-1) — adversarial, deterministic real-DB spec
 * authored by a SEPARATE test author (does NOT touch the impl).
 *
 * Feature under test:
 *   SignatureRequestsService.resendForOwner(orgId, ownerId, requestId, ctx?)
 *   → POST /api/v1/portal/signatures/:id/resend  (TenantAuthGuard, throttle 3/10min)
 *
 * A logged-in apartment owner (tenant tier) re-sends THEIR OWN pending signing
 * link to their on-file phone/email. Behavior (per brief):
 *  - withTenant(orgId): loads signature_request WHERE id=requestId AND
 *    owner_id=ownerId; not-found OR not 'pending' → no-oracle 404
 *  - re-mints a fresh token (new jti + new 7-day expiresAt) via tokenService.sign
 *  - atomically UPDATEs jti+expiresAt WHERE id AND owner_id AND status='pending'
 *  - audits 'signature_request.resend_by_owner' (actorType 'system')
 *  - delivers (email+sms) and returns a SignatureDeliveryReport with the
 *    whatsapp channel STRIPPED to {available:false, reason:'delivered_out_of_band'}
 *    so the token-bearing deep-link is NEVER in the response.
 *
 * Threat model probed here (the things that would be a real security bug):
 *  - CROSS-OWNER (the security crux): owner A must NEVER be able to resend
 *    owner B's request. A call with ownerId=A on B's request must 404 AND leave
 *    B's row jti UNCHANGED (no cross-owner link rotation / griefing primitive).
 *  - Token leak: the token / signUrl / a JWT-shaped string must NOT appear
 *    anywhere in JSON.stringify(report); whatsapp.deepLink must be undefined.
 *  - Is the OLD link actually invalidated? (the persisted jti MUST change.)
 *  - Is resend ALLOWED on a signed/cancelled own request? (must 404, jti unchanged.)
 *  - Is a foreign-org request a no-oracle 404 (RLS) with zero mutation?
 *
 * Seeding/construction patterns mirror signature-requests-resend.spec.ts +
 * signature-requests-bulk.spec.ts. The tokenStub returns a FRESH, unique
 * token+jti each call (so "jti changed" is meaningful). A JWT-shaped token
 * prefix makes the "no raw token leak" assertion real.
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let foreignOrg: TestOrg;
let managerId: string;
let projectId: string;
let doc: string;
let foreignDoc: string;
let ownerA: string;
let ownerB: string;
let foreignOwner: string;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** A deterministic JWT-SHAPED string so the "no raw token leak" assertion is
 *  real. Each call returns a FRESH token + a FRESH jti — exactly like the real
 *  tokenService — so asserting "the row's jti changed after resend" is
 *  meaningful (a buggy impl that re-uses the old jti would be caught), and the
 *  new expiry is ~7 days out (the real contract). */
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.OWNERRESENDTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-ownerresend-${mintCount}-${randomUUID()}`,
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

async function seedDoc(orgId: string, pid: string, mgrId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'd.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [orgId, pid, `org/${orgId}/doc/${randomUUID()}`, mgrId],
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
 *  status, for a chosen owner, so we can drive resendForOwner against
 *  pending/signed/cancelled rows and cross-owner combos independently of
 *  create(). Returns the row id. */
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

/** Read (jti, expires_at, status) for a request via providerPool (BYPASSRLS)
 *  so assertions are independent of any org context — the ground-truth oracle
 *  for "did the OLD link actually die / clock restart / status hold". */
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

/** Did an owner-resend audit row land for this request? */
async function countOwnerResendAudits(targetId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'signature_request.resend_by_owner' AND target_id = $1`,
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
  const tag = `ownerresend-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  doc = await seedDoc(org.id, projectId, managerId);
  ownerA = await seedOwner(org.id);
  ownerB = await seedOwner(org.id);

  // Foreign org + its own doc/owner (cross-org RLS target).
  const ftag = `ownerresend-foreign-${Date.now()}`;
  foreignOrg = await createTestOrg(ftag, ftag);
  foreignDoc = await seedDoc(foreignOrg.id, foreignOrg.projects[0]!.id, foreignOrg.users[0]!.id);
  foreignOwner = await seedOwner(foreignOrg.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('resendForOwner — happy path (own pending → refreshed link, no token leak)', () => {
  it('RO-1) OWN pending → succeeds: jti CHANGED in DB, expiry refreshed ~7d, status still pending, audit landed', async () => {
    const id = await seedRequest(org.id, doc, ownerA, 'pending');
    const before = await readRow(id);
    expect(before).not.toBeNull();
    expect(before!.status).toBe('pending');

    const report = await svc.resendForOwner(org.id, ownerA, id);

    // Returns a per-channel delivery report (email + sms present).
    expect(report).toBeDefined();
    expect(report.email.status).toBe('sent');
    expect(report.sms.status).toBe('sent');

    const after = await readRow(id);
    expect(after).not.toBeNull();
    // CRITICAL: the OLD link is dead — the persisted jti must DIFFER.
    expect(after!.jti).not.toBe(before!.jti);
    expect(after!.jti).toMatch(/^jti-ownerresend-/); // wrote a NEW minted jti
    // The clock restarted: strictly later than seed (now()+2d) AND ~7d out.
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    const expectedExpiry = Date.now() + SEVEN_DAYS_MS;
    expect(Math.abs(after!.expiresAt.getTime() - expectedExpiry)).toBeLessThan(5 * 60 * 1000);
    // Status unchanged — resend does NOT advance the state machine.
    expect(after!.status).toBe('pending');

    expect(await countOwnerResendAudits(id)).toBe(1);
  }, 30_000);

  it('RO-2) the returned report contains NO token/signUrl/JWT anywhere; whatsapp stripped (deepLink undefined, available=false)', async () => {
    const id = await seedRequest(org.id, doc, ownerA, 'pending');
    const report = await svc.resendForOwner(org.id, ownerA, id);

    // The token-bearing deep-link is the resident's credential — it must be
    // delivered out-of-band (SMS/email), NEVER echoed in the HTTP response.
    expect(report.whatsapp.available).toBe(false);
    expect(report.whatsapp.reason).toBe('delivered_out_of_band');
    expect(report.whatsapp.deepLink).toBeUndefined();

    // No JWT-shaped string, no /sign/ url, no 'jti' key anywhere in the report.
    const json = JSON.stringify(report);
    expect(json).not.toContain(FAKE_JWT_PREFIX);
    expect(json).not.toContain('/sign/');
    expect(json).not.toContain('https://wa.me/');
    expect(json.toLowerCase()).not.toContain('jti');
  }, 30_000);
});

describe('resendForOwner — CROSS-OWNER scoping (the security crux)', () => {
  it("RO-3) owner A resending owner B's pending request → 404, and B's row jti is UNCHANGED (no cross-owner rotation)", async () => {
    const reqB = await seedRequest(org.id, doc, ownerB, 'pending');
    const before = await readRow(reqB);
    expect(before!.status).toBe('pending');

    // Same org, but the caller is owner A — B's request is NOT theirs.
    await expect(svc.resendForOwner(org.id, ownerA, reqB)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const after = await readRow(reqB);
    // SECURITY: A must not be able to rotate B's live link (would be a DoS /
    // griefing primitive AND a no-oracle leak). The row is byte-identical.
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('pending');
    // No audit row attributed to a cross-owner resend.
    expect(await countOwnerResendAudits(reqB)).toBe(0);
  }, 30_000);
});

describe('resendForOwner — state machine (only OWN pending is resendable)', () => {
  it('RO-4) a SIGNED own request → 404, jti UNCHANGED, no audit', async () => {
    const id = await seedRequest(org.id, doc, ownerA, 'signed');
    const before = await readRow(id);

    await expect(svc.resendForOwner(org.id, ownerA, id)).rejects.toBeInstanceOf(NotFoundException);

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('signed');
    expect(await countOwnerResendAudits(id)).toBe(0);
  }, 30_000);

  it('RO-5) a CANCELLED own request → 404, jti UNCHANGED, no audit', async () => {
    const id = await seedRequest(org.id, doc, ownerA, 'cancelled');
    const before = await readRow(id);

    await expect(svc.resendForOwner(org.id, ownerA, id)).rejects.toBeInstanceOf(NotFoundException);

    const after = await readRow(id);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('cancelled');
    expect(await countOwnerResendAudits(id)).toBe(0);
  }, 30_000);
});

describe('resendForOwner — not found / cross-org RLS (no oracle)', () => {
  it('RO-6) unknown random requestId → 404', async () => {
    await expect(svc.resendForOwner(org.id, ownerA, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  }, 30_000);

  it('RO-7) a request in ANOTHER org, called with the first org id → 404 (RLS), zero mutation', async () => {
    // Pending request fully inside the foreign org (its own doc + owner).
    const foreignReq = await seedRequest(foreignOrg.id, foreignDoc, foreignOwner, 'pending');
    const before = await readRow(foreignReq);

    // Caller is scoped to `org.id` — RLS hides the foreign row entirely.
    await expect(svc.resendForOwner(org.id, foreignOwner, foreignReq)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const after = await readRow(foreignReq);
    expect(after!.jti).toBe(before!.jti);
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    expect(after!.status).toBe('pending');
    expect(await countOwnerResendAudits(foreignReq)).toBe(0);
  }, 30_000);
});
