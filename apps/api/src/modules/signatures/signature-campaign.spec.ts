/**
 * S5b (Phase-6) — SIGNATURE CAMPAIGN fan-out. Adversarial, deterministic
 * real-DB acceptance spec authored by a SEPARATE test author (does NOT touch
 * the impl). RED against current code (no campaign method exists yet),
 * GREEN after the builder lands `createCampaign`.
 *
 * Feature under test (SPEC): a NEW
 *   POST /api/v1/projects/:id/signature-campaign { documentId, expiresInDays? }
 * → derives ALL distinct ACTIVE owners across the project's apartments
 *   (owner → ownerships[ended_at IS NULL, relationship='owner'] → apartments
 *    → buildings → project = :id)
 * and fans out signature requests for `documentId` by REUSING the existing
 * `createBulk` path — so the Slice-1 #2 association gate + the #3 expired-dedup
 * (skip owners with a LIVE pending request) all apply. Returns
 *   { created, skipped, total }.
 * The document must belong to the project. Reuses the signatures.create
 * permission + withTenant + the per-route throttle.
 *
 * These tests exercise the SERVICE method directly (mirroring
 * signature-requests-bulk.spec.ts), because the controller/guard layer is
 * already covered by the existing signatures suites and the campaign's whole
 * value is the OWNER-DERIVATION + reuse-of-createBulk logic, which lives in the
 * service. The builder is expected to expose:
 *
 *   svc.createCampaign(user, projectId, { documentId, expiresInDays? })
 *     → Promise<{ created: number; skipped: number; total: number }>
 *
 * Seeding mirrors projects-signature-progress.spec.ts (multi-owner ATOMIC seed
 * via seedEqualOwnerships — the S3b deferred-trigger lesson) + the
 * signature-requests-bulk.spec.ts document/pending harness.
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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

const MGR_SID = '00000000-0000-4000-8000-0000000000c1';

/** Deterministic JWT-shaped token (same shape as the real tokenService) so a
 *  campaign that fans out via createBulk mints one per owner. */
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.CAMPAIGNSPECTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: 'jti-' + randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
} as never;

const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's', status: 'sent' as const }),
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

/** Invoke the (not-yet-existing) campaign method through an indirection so the
 *  whole suite RED-fails with a CLEAR message ("createCampaign is not a
 *  function") rather than a TypeScript compile error, and so the exact builder
 *  signature is pinned in ONE place. */
async function runCampaign(
  user: AccessTokenPayload,
  projectId: string,
  input: { documentId: string; expiresInDays?: number },
): Promise<{ created: number; skipped: number; total: number }> {
  const fn = (svc as unknown as Record<string, unknown>)['createCampaign'];
  if (typeof fn !== 'function') {
    throw new Error(
      'SignatureRequestsService.createCampaign is not implemented yet ' +
        '(POST /projects/:id/signature-campaign). RED until the builder lands it.',
    );
  }
  return (
    fn as (
      u: AccessTokenPayload,
      p: string,
      i: { documentId: string; expiresInDays?: number },
    ) => Promise<{ created: number; skipped: number; total: number }>
  ).call(svc, user, projectId, input);
}

/** Save/restore-mutate the live `serverEnv.CAMPAIGN_SEND_ENABLED` flag (mirrors
 *  signup-flag.controller.spec.ts withFlag). Under the API vitest config
 *  (SKIP_ENV_VALIDATION=true) `serverEnv` is the live process.env object;
 *  mutating the property directly works in both validated + skipped modes. */
const SEND_FLAG = 'CAMPAIGN_SEND_ENABLED' as const;
async function withSendFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const env = serverEnv as unknown as Record<string, string | undefined>;
  const had = Object.prototype.hasOwnProperty.call(env, SEND_FLAG);
  const prev = env[SEND_FLAG];
  if (value === undefined) {
    delete env[SEND_FLAG];
  } else {
    env[SEND_FLAG] = value;
  }
  try {
    return await fn();
  } finally {
    if (had) {
      env[SEND_FLAG] = prev;
    } else {
      delete env[SEND_FLAG];
    }
  }
}

let nidCounter = 700000001;
function natId(): string {
  return String(nidCounter++);
}

/** Seed a dedicated project (the factory only creates 2 per org; the
 *  cross-project isolation tests need their own fresh project). */
async function seedProject(orgId: string, createdBy: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, status, created_by)
       VALUES ($1, $2, 'tama38_1', 'gathering_signatures', $3) RETURNING id`,
      [orgId, `Proj-${randomUUID()}`, createdBy],
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

/** Active 100%-owner ownership of ONE apartment (sum trigger happy). */
async function seedSoleOwnership(apartmentId: string, ownerId: string): Promise<void> {
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

/** Seed N co-owners on ONE apartment with EQUAL exact fractions (1/N each) in a
 *  SINGLE transaction — the DEFERRABLE INITIALLY DEFERRED ownership-sum trigger
 *  evaluates ONCE over the complete 100% set (autocommit per-owner trips
 *  5000/10000 != 1 on the first insert — the S3b deferred-trigger lesson). */
async function seedEqualOwnerships(apartmentId: string, ownerIds: string[]): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    for (const ownerId of ownerIds) {
      await c.query(
        `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship,
           share_numerator, share_denominator)
         VALUES ($1, $2, $3, 'owner', 1, $4)`,
        [apartmentId, ownerId, (100 / ownerIds.length).toFixed(2), ownerIds.length],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** End an owner's ownership of an apartment (ended_at set) so they are NO LONGER
 *  an ACTIVE owner — the campaign must NOT fan out to them. */
async function endOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE ownerships SET ended_at = now() WHERE apartment_id = $1 AND owner_id = $2`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}

/** Finalised PROJECT-scoped document (uploaded_at set → eligible to sign). */
async function seedProjectDoc(orgId: string, projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'plan.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now())
       RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Finalised APARTMENT-scoped document under another apartment (NOT project
 *  scope) — used to prove the "document must belong to the project" gate. */
async function seedApartmentDoc(
  orgId: string,
  apartmentId: string,
  uploadedBy: string,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, apartment_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'apt.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now())
       RETURNING id`,
      [orgId, apartmentId, `org/${orgId}/doc/${randomUUID()}`, uploadedBy],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Pre-create a LIVE pending signature_request directly (bypasses the service)
 *  so we can assert skipped without depending on the campaign itself. */
async function seedPending(documentId: string, ownerId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'pending', now() + interval '1 day', $5) RETURNING id`,
      [org.id, documentId, ownerId, 'jti-' + randomUUID(), managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Count pending+all signature_requests rows for (doc, owner) via providerPool
 *  (BYPASSRLS) so the assertion is org-context-independent. */
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

async function countRowsForDoc(documentId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM signature_requests WHERE document_id = $1`,
      [documentId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `campaign-sig-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;

  const ftag = `campaign-foreign-${Date.now()}`;
  foreignOrg = await createTestOrg(ftag, ftag);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('signature-campaign — fan-out to ALL active project owners', () => {
  it('CAMP-1) project with 2 apartments + 3 distinct owners → created=3, total=3, a request per owner', async () => {
    const projectId = org.projects[0]!.id;
    const buildingId = await seedBuilding(projectId);
    // Apartment A: 1 sole owner. Apartment B: 2 co-owners (atomic seed).
    const aptA = await seedApartment(buildingId);
    const aptB = await seedApartment(buildingId);
    const owner1 = await seedOwner(org.id);
    const owner2 = await seedOwner(org.id);
    const owner3 = await seedOwner(org.id);
    await seedSoleOwnership(aptA, owner1);
    await seedEqualOwnerships(aptB, [owner2, owner3]);

    const doc = await seedProjectDoc(org.id, projectId);

    const res = await runCampaign(manager(), projectId, { documentId: doc });

    expect(res.total).toBe(3);
    expect(res.created).toBe(3);
    expect(res.skipped).toBe(0);

    // Exactly one signature_request now exists for each distinct owner on the doc.
    expect(await countRows(doc, owner1)).toBe(1);
    expect(await countRows(doc, owner2)).toBe(1);
    expect(await countRows(doc, owner3)).toBe(1);
    expect(await countRowsForDoc(doc)).toBe(3);
  }, 60_000);
});

describe('signature-campaign — #3 expired-dedup applies via createBulk', () => {
  it('CAMP-2) one owner already has a LIVE pending request → that owner skipped (created=2, skipped=1, total=3)', async () => {
    const projectId = org.projects[1]!.id;
    const buildingId = await seedBuilding(projectId);
    const aptA = await seedApartment(buildingId);
    const aptB = await seedApartment(buildingId);
    const aptC = await seedApartment(buildingId);
    const owner1 = await seedOwner(org.id);
    const owner2 = await seedOwner(org.id);
    const owner3 = await seedOwner(org.id);
    await seedSoleOwnership(aptA, owner1);
    await seedSoleOwnership(aptB, owner2);
    await seedSoleOwnership(aptC, owner3);

    const doc = await seedProjectDoc(org.id, projectId);
    // owner1 already has a LIVE pending request → must be skipped (the #3 dedup).
    await seedPending(doc, owner1);

    const res = await runCampaign(manager(), projectId, { documentId: doc });

    expect(res.total).toBe(3);
    expect(res.skipped).toBe(1);
    expect(res.created).toBe(2);

    // owner1 still has exactly ONE row (the pre-seeded one — no duplicate insert).
    expect(await countRows(doc, owner1)).toBe(1);
    expect(await countRows(doc, owner2)).toBe(1);
    expect(await countRows(doc, owner3)).toBe(1);
  }, 60_000);
});

describe('signature-campaign — document must belong to the project', () => {
  it('CAMP-3) documentId scoped to a DIFFERENT project → rejected (4xx), NO requests created', async () => {
    const projectId = await seedProject(org.id, managerId);
    const buildingId = await seedBuilding(projectId);
    const aptA = await seedApartment(buildingId);
    const owner1 = await seedOwner(org.id);
    await seedSoleOwnership(aptA, owner1);

    // A finalised, project-scoped doc that belongs to a DIFFERENT project.
    const otherProjectId = org.projects[0]!.id;
    const foreignScopeDoc = await seedProjectDoc(org.id, otherProjectId);

    // 400 (BadRequest) or 404 (no-oracle) — both are HttpException. (The bare
    // missing-method Error is NOT an HttpException, so this stays RED until the
    // builder lands the document-belongs-to-project gate.)
    await expect(
      runCampaign(manager(), projectId, { documentId: foreignScopeDoc }),
    ).rejects.toBeInstanceOf(HttpException);

    // No requests created against the campaign target's owner.
    expect(await countRows(foreignScopeDoc, owner1)).toBe(0);
  }, 60_000);

  it('CAMP-3b) documentId scoped to an APARTMENT outside the project → rejected, NO requests created', async () => {
    const projectId = await seedProject(org.id, managerId);
    const buildingId = await seedBuilding(projectId);
    const aptA = await seedApartment(buildingId);
    const owner1 = await seedOwner(org.id);
    await seedSoleOwnership(aptA, owner1);

    // An apartment-scoped doc on an apartment under a DIFFERENT project.
    const otherBuilding = await seedBuilding(org.projects[0]!.id);
    const otherApt = await seedApartment(otherBuilding);
    const aptDoc = await seedApartmentDoc(org.id, otherApt, managerId);

    await expect(runCampaign(manager(), projectId, { documentId: aptDoc })).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(await countRowsForDoc(aptDoc)).toBe(0);
  }, 60_000);
});

describe('signature-campaign — cross-org scoping', () => {
  it('CAMP-4) project in ANOTHER org → 404, NO requests created', async () => {
    const foreignProjectId = foreignOrg.projects[0]!.id;
    const fBuilding = await seedBuilding(foreignProjectId);
    const fApt = await seedApartment(fBuilding);
    const fOwner = await withTenant(foreignOrg.id, async (tx) => {
      const pii = await encryptOwnerPii(tx as never, {
        nationalId: natId(),
        name: 'בעלים',
        phone: '0541112222',
      });
      const [row] = await tx
        .insert(owners)
        .values({
          orgId: foreignOrg.id,
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
    await seedSoleOwnership(fApt, fOwner);
    const fDoc = await seedProjectDoc(foreignOrg.id, foreignProjectId);

    // Manager of `org` campaigning a project in `foreignOrg` → no-oracle 404.
    await expect(
      runCampaign(manager(), foreignProjectId, { documentId: fDoc }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(await countRowsForDoc(fDoc)).toBe(0);
  }, 60_000);
});

describe('signature-campaign — only ACTIVE owners IN THIS PROJECT are fanned out', () => {
  it('CAMP-5) an ended (inactive) ownership is NOT included; an owner only in a DIFFERENT project is NOT included', async () => {
    const projectId = await seedProject(org.id, managerId);
    const buildingId = await seedBuilding(projectId);
    const aptActive = await seedApartment(buildingId);
    const aptEnded = await seedApartment(buildingId);
    const activeOwner = await seedOwner(org.id);
    const endedOwner = await seedOwner(org.id);
    await seedSoleOwnership(aptActive, activeOwner);
    // Seed then END this ownership → owner is no longer ACTIVE in the project.
    await seedSoleOwnership(aptEnded, endedOwner);
    await endOwnership(aptEnded, endedOwner);

    // An owner that is active ONLY in a DIFFERENT project must not be pulled in.
    const otherProjectId = org.projects[0]!.id;
    const otherBuilding = await seedBuilding(otherProjectId);
    const otherApt = await seedApartment(otherBuilding);
    const otherProjectOwner = await seedOwner(org.id);
    await seedSoleOwnership(otherApt, otherProjectOwner);

    const doc = await seedProjectDoc(org.id, projectId);

    const res = await runCampaign(manager(), projectId, { documentId: doc });

    // Only the single ACTIVE owner of THIS project is targeted.
    expect(res.total).toBe(1);
    expect(res.created).toBe(1);
    expect(await countRows(doc, activeOwner)).toBe(1);
    expect(await countRows(doc, endedOwner)).toBe(0);
    expect(await countRows(doc, otherProjectOwner)).toBe(0);
  }, 60_000);
});

describe('signature-campaign — CAMPAIGN_SEND_ENABLED kill-switch (E2 Wave-0 N15)', () => {
  it('CAMP-6) default/unset env → campaign proceeds (happy path unaffected by the switch)', async () => {
    const projectId = await seedProject(org.id, managerId);
    const buildingId = await seedBuilding(projectId);
    const apt = await seedApartment(buildingId);
    const owner1 = await seedOwner(org.id);
    await seedSoleOwnership(apt, owner1);
    const doc = await seedProjectDoc(org.id, projectId);

    const res = await withSendFlag(undefined, () =>
      runCampaign(manager(), projectId, { documentId: doc }),
    );

    expect(res.total).toBe(1);
    expect(res.created).toBe(1);
    expect(await countRows(doc, owner1)).toBe(1);
  }, 60_000);

  it("CAMP-7) env CAMPAIGN_SEND_ENABLED='0' → 503 campaign_send_disabled, NO fan-out (no requests created)", async () => {
    const projectId = await seedProject(org.id, managerId);
    const buildingId = await seedBuilding(projectId);
    const apt = await seedApartment(buildingId);
    const owner1 = await seedOwner(org.id);
    await seedSoleOwnership(apt, owner1);
    const doc = await seedProjectDoc(org.id, projectId);

    let caught: unknown;
    await withSendFlag('0', async () => {
      try {
        await runCampaign(manager(), projectId, { documentId: doc });
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getResponse()).toEqual({
      error: { code: 'campaign_send_disabled' },
    });
    // No fan-out: the kill-switch gates BEFORE createBulk, so zero rows exist.
    expect(await countRowsForDoc(doc)).toBe(0);
  }, 60_000);
});
