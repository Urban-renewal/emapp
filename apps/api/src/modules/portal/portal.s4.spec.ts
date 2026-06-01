/**
 * V11 Track B.S4 — Tenant Portal service-level integration spec (D.40).
 *
 * The portal exposes 4 read-only endpoints to a tenant under the
 * `emapp-tenant` JWT audience; each method is scoped to the JWT's
 * `sub` (the tenant's owner.id). This spec instantiates PortalService
 * directly and hits real Neon for the RLS + own-scoping invariants.
 *
 * Coverage:
 *   1) getMe returns the tenant's own cleartext PII
 *   2) getApartments returns the apartment(s) the tenant owns, joined
 *      to building + project, with ownership pct
 *   3) getDocuments returns docs scoped to the tenant's apartments;
 *      project-level docs (apartmentId NULL) are excluded
 *   4) getSignatures returns sig requests where the tenant is recipient
 *   5) Own-only isolation: tenant B (same org) sees only their own data
 *   6) Archived owner → 404 on getMe
 *
 * No JWT verification in this spec — the guard is unit-tested elsewhere
 * (tenant-auth.guard.spec.ts); here we feed the resolved payload
 * directly, mirroring projects.s2 / imports.s8.
 */
import {
  apartments,
  buildings,
  documents,
  encryptOwnerPii,
  owners,
  ownerships,
  signatureRequests,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { TenantTokenPayload } from '../auth/tenant/tenant-auth.guard';

import { PortalService } from './portal.service';

const svc = new PortalService();

let orgA: TestOrg;
let orgB: TestOrg;

// Fixture ids — filled in beforeAll.
const fx = {
  tenantAOwnerId: '',
  tenantBOwnerId: '',
  tenantCOwnerId: '', // orgB
  archivedOwnerId: '',
  tenantAApartmentId: '',
  tenantBApartmentId: '',
  tenantADocumentId: '',
  tenantASignatureId: '',
};

function tenantOf(o: TestOrg, ownerId: string): TenantTokenPayload {
  return {
    sub: ownerId,
    orgId: o.id,
    role: 'tenant',
    type: 'tenant_access',
    // Wave 4 M-1: sid is now a required claim. Tests that only exercise
    // PortalService read methods (not the guard, not logout) can supply
    // any uuid here; the read methods don't read `sid`. The M-1 path
    // (logout + guard revocation check) is covered in portal.m1.spec.ts.
    sid: '00000000-0000-0000-0000-000000000000',
  };
}

/** Insert an owner with encrypted PII via the same helper the prod
 *  write path uses (so the SQL decrypt in the service has a real
 *  ciphertext to chew on). Uses the provider pool to bypass RLS for
 *  test setup — same posture as factories.ts. */
async function makeOwner(
  o: TestOrg,
  args: { name: string; nationalId: string; phone: string; archived?: boolean },
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    // encryptOwnerPii needs the encryption GUC; withTenant has set it.
    // We pass the same tx to the helper so the pgcrypto SELECT runs on
    // the connection that has app.encryption_key set.
    // Drizzle's NodePgDatabase isn't directly compatible with the
    // helper's `Database` typing — cast through unknown (test scope).
    const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
      name: args.name,
      nationalId: args.nationalId,
      phone: args.phone,
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: o.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
        archivedAt: args.archived ? new Date() : null,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function makeApartment(o: TestOrg, projectIdx = 0): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId: o.projects[projectIdx]!.id,
        address: `Portal Test ${Date.now()}-${Math.random()}`,
        city: 'Tel Aviv',
      })
      .returning({ id: buildings.id });
    const [apt] = await tx
      .insert(apartments)
      .values({
        buildingId: bld!.id,
        number: `P-${Date.now()}-${Math.random()}`,
      })
      .returning({ id: apartments.id });
    return apt!.id;
  });
}

async function makeOwnership(
  o: TestOrg,
  apartmentId: string,
  ownerId: string,
  pct = '100',
): Promise<void> {
  await withTenant(o.id, async (tx) => {
    await tx.insert(ownerships).values({ apartmentId, ownerId, ownershipPct: pct, role: 'owner' });
  });
}

async function makeDocument(o: TestOrg, apartmentId: string, name: string): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        orgId: o.id,
        apartmentId,
        name,
        type: 'contract',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        r2Key: `org/${o.id}/doc/${Date.now()}-${Math.random()}.pdf`,
        contentHash: 'sha256:' + 'd'.repeat(64),
        uploadedBy: o.users[0]!.id,
      })
      .returning({ id: documents.id });
    return row!.id;
  });
}

async function makeSignatureRequest(
  o: TestOrg,
  documentId: string,
  ownerId: string,
  status: 'pending' | 'signed' | 'cancelled' = 'pending',
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .insert(signatureRequests)
      .values({
        orgId: o.id,
        documentId,
        ownerId,
        jti: `jti-portal-${Date.now()}-${Math.random()}`,
        status,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdBy: o.users[0]!.id,
      })
      .returning({ id: signatureRequests.id });
    return row!.id;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`B4A-${ts}`, `b4a-${ts}`);
  orgB = await createTestOrg(`B4B-${ts}`, `b4b-${ts}`);
  // Generous timeout — fixture setup is ~20 sequential withTenant
  // round-trips against real Neon; default 10s is too tight.

  // Two owners in orgA (tenantA + tenantB) and one in orgB (tenantC).
  // Each gets their own apartment + ownership. A 4th owner is archived
  // for the 404 test.
  fx.tenantAOwnerId = await makeOwner(orgA, {
    name: 'דוד תנעמי',
    nationalId: '203456789',
    phone: '0501234567',
  });
  fx.tenantBOwnerId = await makeOwner(orgA, {
    name: 'שרה כהן',
    nationalId: '203456790',
    phone: '0501234568',
  });
  fx.tenantCOwnerId = await makeOwner(orgB, {
    name: 'יוסי לוי',
    nationalId: '203456791',
    phone: '0501234569',
  });
  fx.archivedOwnerId = await makeOwner(orgA, {
    name: 'archived person',
    nationalId: '203456792',
    phone: '0501234570',
    archived: true,
  });

  fx.tenantAApartmentId = await makeApartment(orgA);
  fx.tenantBApartmentId = await makeApartment(orgA);
  const tenantCApartmentId = await makeApartment(orgB);

  await makeOwnership(orgA, fx.tenantAApartmentId, fx.tenantAOwnerId);
  await makeOwnership(orgA, fx.tenantBApartmentId, fx.tenantBOwnerId);
  await makeOwnership(orgB, tenantCApartmentId, fx.tenantCOwnerId);

  // One document + one signature request on tenant A's apartment.
  fx.tenantADocumentId = await makeDocument(orgA, fx.tenantAApartmentId, 'Tenant A Contract');
  fx.tenantASignatureId = await makeSignatureRequest(orgA, fx.tenantADocumentId, fx.tenantAOwnerId);
}, 60_000);

afterAll(async () => {
  /* pool teardown handled by global-setup */
  void providerPool;
});

describe('V11 B.S4 · PortalService — Tenant Portal own-data view (D.40)', () => {
  it('1) getMe — D.47: own national_id + phone are MASKED, cleartext NEVER on the wire', async () => {
    const me = await svc.getMe(tenantOf(orgA, fx.tenantAOwnerId));
    expect(me.id).toBe(fx.tenantAOwnerId);
    expect(me.organizationId).toBe(orgA.id);
    expect(me.name).toBe('דוד תנעמי');
    // Masked: `•••••••XX` (last 2) / `•••••XXXX` (last 4).
    expect(me.nationalIdMasked).toBe('•••••••89');
    expect(me.phoneMasked).toBe('•••••4567');
    // SEC-1 — the cleartext must NOT appear anywhere in the response.
    const blob = JSON.stringify(me);
    expect(blob).not.toContain('203456789');
    expect(blob).not.toContain('0501234567');
  });

  it("2) getApartments — returns the tenant's 1 owned apartment with building+project context", async () => {
    const { data } = await svc.getApartments(tenantOf(orgA, fx.tenantAOwnerId));
    expect(data).toHaveLength(1);
    const row = data[0]!;
    expect(row.apartment.id).toBe(fx.tenantAApartmentId);
    expect(row.building.city).toBe('Tel Aviv');
    expect(row.project.id).toBe(orgA.projects[0]!.id);
    expect(row.ownership.pct).toBe(100);
    expect(row.ownership.role).toBe('owner');
  });

  it("3) getDocuments — returns docs on tenant's apartment (no project-level leak)", async () => {
    const { data } = await svc.getDocuments(tenantOf(orgA, fx.tenantAOwnerId));
    const ours = data.filter((d) => d.id === fx.tenantADocumentId);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.apartmentId).toBe(fx.tenantAApartmentId);
    expect(ours[0]?.name).toBe('Tenant A Contract');
    // Every doc in the response must belong to one of tenant A's apartments
    // (in this test, only fx.tenantAApartmentId).
    for (const d of data) {
      expect(d.apartmentId).toBe(fx.tenantAApartmentId);
    }
  });

  it('4) getSignatures — returns sig requests where tenant is recipient; NEVER exposes `jti`', async () => {
    const { data } = await svc.getSignatures(tenantOf(orgA, fx.tenantAOwnerId));
    const ours = data.filter((s) => s.id === fx.tenantASignatureId);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.status).toBe('pending');
    expect(ours[0]?.documentName).toBe('Tenant A Contract');
    // Wire-shape forensic: NO jti, NO signUrl, NO token-shaped field.
    // Re-check at the structural level (key set, not value scan, so
    // the assertion stays meaningful even if a token happened to look
    // like a normal UUID).
    const allowedKeys = new Set([
      'id',
      'documentId',
      'documentName',
      'status',
      'expiresAt',
      'createdAt',
      'signedAt',
      'cancelledAt',
    ]);
    for (const key of Object.keys(ours[0]!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it('5) own-only isolation — tenant B (same org) sees disjoint data from tenant A', async () => {
    const [meB, aptsB, docsB, sigsB] = await Promise.all([
      svc.getMe(tenantOf(orgA, fx.tenantBOwnerId)),
      svc.getApartments(tenantOf(orgA, fx.tenantBOwnerId)),
      svc.getDocuments(tenantOf(orgA, fx.tenantBOwnerId)),
      svc.getSignatures(tenantOf(orgA, fx.tenantBOwnerId)),
    ]);

    // Self id, not tenant A.
    expect(meB.id).toBe(fx.tenantBOwnerId);
    expect(meB.name).toBe('שרה כהן');

    // Tenant B owns apt B only; tenant A's apt MUST NOT appear.
    expect(aptsB.data.map((r) => r.apartment.id)).not.toContain(fx.tenantAApartmentId);
    expect(aptsB.data.map((r) => r.apartment.id)).toContain(fx.tenantBApartmentId);

    // Tenant B has no documents (none attached to apt B) and no sigs.
    expect(docsB.data.map((d) => d.id)).not.toContain(fx.tenantADocumentId);
    expect(sigsB.data.map((s) => s.id)).not.toContain(fx.tenantASignatureId);
  });

  it("7) getProgress — AGGREGATE counts for the tenant's project; NO owner identity/PII", async () => {
    // Baseline (one seeded pending on tenant A's project).
    const before = (await svc.getProgress(tenantOf(orgA, fx.tenantAOwnerId))).data.find(
      (p) => p.projectId === orgA.projects[0]!.id,
    )!;

    // Seed a CANCELLED request on the same project — it must NOT count.
    await makeSignatureRequest(orgA, fx.tenantADocumentId, fx.tenantAOwnerId, 'cancelled');

    const { data } = await svc.getProgress(tenantOf(orgA, fx.tenantAOwnerId));
    const row = data.find((p) => p.projectId === orgA.projects[0]!.id);
    expect(row).toBeDefined();
    // Tenant A's project has ≥1 ACTIVE signature request (the pending one).
    expect(row!.signaturesTotal).toBeGreaterThanOrEqual(1);
    expect(row!.signaturesPending).toBeGreaterThanOrEqual(1);
    expect(row!.signaturesSigned).toBeGreaterThanOrEqual(0);
    // total = signed + pending (cancelled EXCLUDED — denominator mechanism).
    expect(row!.signaturesTotal).toBe(row!.signaturesPending + row!.signaturesSigned);
    // The cancelled request did NOT change the total/pending — it is excluded.
    expect(row!.signaturesTotal).toBe(before.signaturesTotal);
    expect(row!.signaturesPending).toBe(before.signaturesPending);
    // Scope-critical: the row carries ONLY aggregate fields — no owner
    // id/name/national_id/phone, no per-resident breakdown.
    const allowedKeys = new Set([
      'projectId',
      'projectName',
      'status',
      'signaturesSigned',
      'signaturesPending',
      'signaturesTotal',
    ]);
    for (const key of Object.keys(row!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    const blob = JSON.stringify(data);
    expect(blob).not.toContain('203456789'); // tenant A national_id
    expect(blob).not.toContain('0501234567'); // tenant A phone
  });

  it('8) getProgress — cross-org isolation: tenant C (orgB) never sees orgA projects', async () => {
    const { data } = await svc.getProgress(tenantOf(orgB, fx.tenantCOwnerId));
    expect(data.map((p) => p.projectId)).not.toContain(orgA.projects[0]!.id);
  });

  it('6) archived owner → 404 on getMe', async () => {
    // NestJS NotFoundException constructed with an object body keeps
    // "Not Found Exception" as the .message and the {error:{code}}
    // shape on .response. Assert on the response body — that's what
    // the FE actually consumes (D.16 envelope).
    let caught: unknown;
    try {
      await svc.getMe(tenantOf(orgA, fx.archivedOwnerId));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const resp = (caught as { response?: { error?: { code?: string } } }).response;
    expect(resp?.error?.code).toBe('not_found');
  });
});
