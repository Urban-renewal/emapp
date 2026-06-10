/**
 * SIGNATURE-REQUEST CORRECTNESS (S1) — adversarial, deterministic real-DB spec
 * authored by a SEPARATE test author (does NOT touch the impl). This is the
 * REPRODUCE-BEFORE-FIX gate: these tests are RED against the CURRENT code
 * (proving the two bugs are real) and go GREEN after the builder's fix.
 *
 * Two correctness bugs in SignatureRequestsService.create():
 *
 * #2 — RECIPIENT-ASSOCIATION GATE (missing entirely today):
 *   Creating a signature request for an owner who is NOT associated with the
 *   document's scope (has NO active `ownership` tying them to the apartment, or
 *   to any apartment in the project) MUST be rejected with error code
 *   `recipient_not_associated`. An ASSOCIATED owner MUST succeed. Covered for
 *   BOTH an apartment-scoped document AND a project-scoped document.
 *   Current code does NO such check → the "non-associated is rejected" tests
 *   are RED now (the create wrongly succeeds).
 *
 * #3 — EXPIRED-DEDUP (the pending-dedup guard ignores expiry today):
 *   An EXPIRED pending request (expires_at <= now()) MUST NOT block creating a
 *   NEW request for the same (document, owner) — the create succeeds. A
 *   NON-expired pending request MUST still block (409 `signature_request_
 *   pending_exists`). Current dedup query filters on status='pending' ONLY,
 *   ignoring expires_at → the "expired doesn't block" test is RED now (the
 *   create wrongly 409s).
 *
 * Seeding patterns mirror signature-requests-resend-for-owner.spec.ts +
 * owners/data-subject.spec.ts (buildings → apartments → owners → ownerships →
 * documents). The tokenStub returns a FRESH token+jti each call; email/sms
 * stubs report 'sent'. All ground-truth row reads go through providerPool
 * (BYPASSRLS) so assertions are org-context independent.
 *
 * NOTE on the D.25 ownership-sum trigger: every apartment that has an `owner`
 * ownership row must sum to 100% at COMMIT. Each apartment here is therefore
 * given a SINGLE owner at 100.00. A "non-associated" owner simply has NO
 * ownership row anywhere (it is NOT a renter — the renter gate is a separate
 * concern and is NOT what #2 is about; a fresh owner passes the renter gate
 * today and, absent the #2 fix, wrongly gets a request).
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let projectA: string; // the project the project-scoped doc belongs to
let projectB: string; // a DIFFERENT project (its owner is non-associated to A)

const MGR_SID = '00000000-0000-4000-8000-0000000000c1';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.CORRECTNESSTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-correct-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
} as never;

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

/** Seed a FINALISED document. Pass projectId for a project-scoped doc, or
 *  apartmentId for an apartment-scoped doc (exactly one). uploaded_at is set
 *  (loadVisibleDocument requires a finalised doc). */
async function seedDoc(
  orgId: string,
  scope: { projectId?: string; apartmentId?: string },
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, apartment_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, 'd.pdf', 'contract', 'application/pdf', 100, $4, 'h', $5, now())
       RETURNING id`,
      [
        orgId,
        scope.projectId ?? null,
        scope.apartmentId ?? null,
        `org/${orgId}/doc/${randomUUID()}`,
        managerId,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Pre-insert a pending signature_request with a chosen expires_at, bypassing
 *  the service — drives the #3 dedup guard against expired vs live rows. */
async function seedPendingRequest(
  orgId: string,
  documentId: string,
  ownerId: string,
  expiresAt: 'expired' | 'live',
): Promise<string> {
  const interval =
    expiresAt === 'expired' ? `now() - interval '1 hour'` : `now() + interval '2 days'`;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'pending', ${interval}, $5) RETURNING id`,
      [orgId, documentId, ownerId, 'jti-seed-' + randomUUID(), managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function countRequests(documentId: string, ownerId: string): Promise<number> {
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
  const tag = `sig-correct-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectA = org.projects[0]!.id;
  projectB = org.projects[1]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// #2 — RECIPIENT-ASSOCIATION GATE
// ───────────────────────────────────────────────────────────────────────────

describe('#2 recipient-association gate — apartment-scoped document', () => {
  it('REJECTS a request to an owner with NO ownership of the apartment → recipient_not_associated, NO row created', async () => {
    const building = await seedBuilding(projectA);
    const apartment = await seedApartment(building);
    const apartmentOwner = await seedOwner(org.id);
    await seedOwnership(apartment, apartmentOwner); // satisfies the 100% sum

    const doc = await seedDoc(org.id, { apartmentId: apartment });

    // A different owner, associated with NOTHING (no ownership row at all).
    const strangerOwner = await seedOwner(org.id);

    await expect(
      svc.create(manager(), { documentId: doc, ownerId: strangerOwner }),
    ).rejects.toMatchObject({
      response: { error: { code: 'recipient_not_associated' } },
    });

    // No request row leaked for the non-associated owner.
    expect(await countRequests(doc, strangerOwner)).toBe(0);
  }, 30_000);

  it('ALLOWS a request to the owner WHO OWNS the apartment → request created (positive control)', async () => {
    const building = await seedBuilding(projectA);
    const apartment = await seedApartment(building);
    const apartmentOwner = await seedOwner(org.id);
    await seedOwnership(apartment, apartmentOwner);

    const doc = await seedDoc(org.id, { apartmentId: apartment });

    const res = await svc.create(manager(), { documentId: doc, ownerId: apartmentOwner });

    expect(res.request).toBeDefined();
    expect(res.request.ownerId).toBe(apartmentOwner);
    expect(res.request.status).toBe('pending');
    expect(await countRequests(doc, apartmentOwner)).toBe(1);
  }, 30_000);
});

describe('#2 recipient-association gate — project-scoped document', () => {
  it('REJECTS a request to an owner with NO apartment in the project → recipient_not_associated, NO row created', async () => {
    // Owner associated with a DIFFERENT project (projectB) — not project A.
    const bBuilding = await seedBuilding(projectB);
    const bApartment = await seedApartment(bBuilding);
    const otherProjectOwner = await seedOwner(org.id);
    await seedOwnership(bApartment, otherProjectOwner);

    const doc = await seedDoc(org.id, { projectId: projectA });

    await expect(
      svc.create(manager(), { documentId: doc, ownerId: otherProjectOwner }),
    ).rejects.toMatchObject({
      response: { error: { code: 'recipient_not_associated' } },
    });

    expect(await countRequests(doc, otherProjectOwner)).toBe(0);
  }, 30_000);

  it('ALLOWS a request to an owner who owns an apartment IN the project → request created (positive control)', async () => {
    const aBuilding = await seedBuilding(projectA);
    const aApartment = await seedApartment(aBuilding);
    const projectOwner = await seedOwner(org.id);
    await seedOwnership(aApartment, projectOwner);

    const doc = await seedDoc(org.id, { projectId: projectA });

    const res = await svc.create(manager(), { documentId: doc, ownerId: projectOwner });

    expect(res.request).toBeDefined();
    expect(res.request.ownerId).toBe(projectOwner);
    expect(res.request.status).toBe('pending');
    expect(await countRequests(doc, projectOwner)).toBe(1);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #3 — EXPIRED-DEDUP: an expired pending request must NOT block a new create
// ───────────────────────────────────────────────────────────────────────────

describe('#3 expired-dedup — pending-request guard must respect expiry', () => {
  it('an EXPIRED pending request does NOT block a new create for the same (doc, owner) → create SUCCEEDS', async () => {
    const building = await seedBuilding(projectA);
    const apartment = await seedApartment(building);
    const owner = await seedOwner(org.id);
    await seedOwnership(apartment, owner); // owner IS associated (isolate #3 from #2)

    const doc = await seedDoc(org.id, { apartmentId: apartment });

    // Pre-existing pending request that has ALREADY expired.
    const expiredId = await seedPendingRequest(org.id, doc, owner, 'expired');

    // The new create must SUCCEED — the expired row is dead and must not dedup.
    const res = await svc.create(manager(), { documentId: doc, ownerId: owner });
    expect(res.request).toBeDefined();
    expect(res.request.status).toBe('pending');
    expect(res.request.id).not.toBe(expiredId);

    // A brand-new pending row exists alongside the expired one (>= 2 rows total).
    expect(await countRequests(doc, owner)).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('a NON-expired pending request STILL blocks a new create → 409 signature_request_pending_exists (control)', async () => {
    const building = await seedBuilding(projectA);
    const apartment = await seedApartment(building);
    const owner = await seedOwner(org.id);
    await seedOwnership(apartment, owner);

    const doc = await seedDoc(org.id, { apartmentId: apartment });

    // Pre-existing LIVE pending request (expires in 2 days).
    await seedPendingRequest(org.id, doc, owner, 'live');

    await expect(svc.create(manager(), { documentId: doc, ownerId: owner })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(svc.create(manager(), { documentId: doc, ownerId: owner })).rejects.toMatchObject({
      response: { error: { code: 'signature_request_pending_exists' } },
    });

    // No second row created — the live pending blocked it.
    expect(await countRequests(doc, owner)).toBe(1);
  }, 30_000);
});
