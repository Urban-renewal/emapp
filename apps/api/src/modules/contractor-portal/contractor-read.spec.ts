/**
 * D2-DEF-1 / D.46 — contractor read-tier security spec (real DB).
 *
 * Drives ContractorReadService directly with a ContractorContext built from
 * a seeded share, and pins the scope-critical invariants (D.51 — a plaster
 * can't pass):
 *   - OWNERS-PII NEVER: the project has a real owner with cleartext PII; NO
 *     contractor response contains the national_id/phone/owner name/owner id.
 *   - AGGREGATE-only: progress is counts (signed+pending, cancelled excluded);
 *     no per-owner signature row is reachable.
 *   - DOCUMENTS scope: only PROJECT-LEVEL docs; per-owner (apartment-linked)
 *     agreements are excluded.
 *   - IDOR download: a doc from ANOTHER project, or an apartment-linked doc,
 *     → 404 (no minted URL); only an in-scope project doc presigns.
 *   - PERMS-DRIVEN: overview/signatures/documents OFF → 403 on the matching
 *     endpoint.
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  contractors,
  defaultSharePermissions,
  documents,
  encryptOwnerPii,
  owners,
  ownerships,
  shares,
  signatureRequests,
  withTenant,
  type IStorageProvider,
} from '@emapp/db';
import type { SharePermissions } from '@emapp/shared-types';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ContractorContext } from './contractor-auth.guard';
import { ContractorReadService } from './contractor-read.service';

const NID = '203456789';
const PHONE = '0501234567';

const fakeStorage: IStorageProvider = {
  getUploadUrl: async () => ({ url: 'https://r2.test/upload', fields: {} }) as never,
  getDownloadUrl: async () => 'https://r2.test/download?sig=abc',
  deleteObject: async () => {},
  headObject: async () => ({ size: 1, contentType: 'application/pdf' }) as never,
} as unknown as IStorageProvider;

let svc: ContractorReadService;
let orgA: TestOrg;
const fx = {
  projectId: '',
  otherProjectId: '',
  contractorId: '',
  shareId: '',
  projectDocId: '',
  apartmentDocId: '',
  otherProjectDocId: '',
  apartmentId: '',
  ownerId: '',
};

function ctx(perms: SharePermissions): ContractorContext {
  return {
    contractorId: fx.contractorId,
    projectId: fx.projectId,
    shareId: fx.shareId,
    orgId: orgA.id,
    permissions: perms,
  };
}

async function seed(): Promise<void> {
  await withTenant(orgA.id, async (tx) => {
    fx.projectId = orgA.projects[0]!.id;
    fx.otherProjectId = orgA.projects[1]?.id ?? orgA.projects[0]!.id;
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId: fx.projectId,
        address: 'Herzl 1',
        city: 'Tel Aviv',
        block: '6941',
        parcel: '120',
      })
      .returning({ id: buildings.id });
    const [apt] = await tx
      .insert(apartments)
      .values({ buildingId: bld!.id, number: '4', floor: 2 })
      .returning({ id: apartments.id });

    // A real owner WITH PII + an ownership (the contractor must NEVER see this).
    const enc = await encryptOwnerPii(tx as never, {
      name: 'דוד תנעמי',
      nationalId: NID,
      phone: PHONE,
    });
    const [own] = await tx
      .insert(owners)
      .values({
        orgId: orgA.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    await tx
      .insert(ownerships)
      .values({ apartmentId: apt!.id, ownerId: own!.id, ownershipPct: '100', role: 'owner' });
    fx.apartmentId = apt!.id;
    fx.ownerId = own!.id;

    // Project-level doc (contractor CAN see) + apartment-level doc (per-owner
    // agreement — contractor must NOT see) + a doc on another project.
    const mkDoc = async (opts: { projectId?: string; apartmentId?: string; name: string }) => {
      const [d] = await tx
        .insert(documents)
        .values({
          orgId: orgA.id,
          projectId: opts.projectId ?? null,
          apartmentId: opts.apartmentId ?? null,
          name: opts.name,
          type: 'contract',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
          r2Key: `org/${orgA.id}/doc/${randomUUID()}.pdf`,
          contentHash: 'sha256:' + 'd'.repeat(64),
          uploadedBy: orgA.users[0]!.id,
          uploadedAt: new Date(), // 0049 — finalised so it's listed/served
        })
        .returning({ id: documents.id });
      return d!.id;
    };
    fx.projectDocId = await mkDoc({ projectId: fx.projectId, name: 'Shared Plan' });
    fx.apartmentDocId = await mkDoc({ apartmentId: apt!.id, name: 'Owner Agreement (per-owner)' });
    fx.otherProjectDocId = await mkDoc({ projectId: fx.otherProjectId, name: 'Other Project Doc' });

    // One signed + one pending + one cancelled signature request on the
    // apartment-level doc (so it belongs to the project via the apartment).
    const mkSr = async (status: 'signed' | 'pending' | 'cancelled') => {
      await tx.insert(signatureRequests).values({
        orgId: orgA.id,
        documentId: fx.apartmentDocId,
        ownerId: own!.id,
        jti: `jti-${randomUUID()}`,
        status,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdBy: orgA.users[0]!.id,
      });
    };
    await mkSr('signed');
    await mkSr('pending');
    await mkSr('cancelled');

    const [c] = await tx
      .insert(contractors)
      .values({
        orgId: orgA.id,
        name: 'BuildCo',
        contactEmail: `bc-${randomUUID()}@test.local`,
        createdBy: orgA.users[0]!.id,
      })
      .returning({ id: contractors.id });
    fx.contractorId = c!.id;
    const [sh] = await tx
      .insert(shares)
      .values({
        projectId: fx.projectId,
        contractorId: c!.id,
        permissions: defaultSharePermissions(),
        createdBy: orgA.users[0]!.id,
      })
      .returning({ id: shares.id });
    fx.shareId = sh!.id;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ContractorReadService(fakeStorage);
  orgA = await createTestOrg(`def1-${Date.now()}`, `def1-${Date.now()}`);
  await seed();
}, 90_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

const FULL = (): SharePermissions => ({
  ...defaultSharePermissions(),
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
});

describe('D2-DEF-1 — contractor getProject', () => {
  it('returns project + buildings + STRUCTURAL apartments; NO owner data anywhere', async () => {
    const view = await svc.getProject(ctx(FULL()));
    expect(view.project.id).toBe(fx.projectId);
    expect(view.buildings.length).toBeGreaterThanOrEqual(1);
    const apt = view.buildings[0]!.apartments[0]!;
    expect(apt.number).toBe('4');
    // Owners-PII NEVER: the cleartext national_id/phone/owner name must be
    // absent from the entire serialized response.
    const blob = JSON.stringify(view);
    expect(blob).not.toContain(NID);
    expect(blob).not.toContain(PHONE);
    expect(blob).not.toContain('תנעמי');
    expect(blob).not.toContain(fx.contractorId); // no internal ids leaked beyond structure
  });

  it('overview OFF → 403', async () => {
    await expect(
      svc.getProject(ctx({ ...FULL(), overview: { on: false } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('D2-DEF-1 — contractor getProgress (aggregate-only)', () => {
  it('returns counts (cancelled excluded); no owner identity', async () => {
    const p = await svc.getProgress(ctx(FULL()));
    expect(p.signaturesSigned).toBe(1);
    expect(p.signaturesPending).toBe(1);
    expect(p.signaturesTotal).toBe(2); // cancelled excluded
    const blob = JSON.stringify(p);
    expect(blob).not.toContain(NID);
    expect(blob).not.toContain('תנעמי');
  });

  it('signatures OFF → 403 (signatureScopeForShare = none)', async () => {
    await expect(
      svc.getProgress(ctx({ ...FULL(), signatures: { on: false } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('D.57 valid-consent: a signed signature on an ARCHIVED doc does NOT count', async () => {
    // Baseline (1 signed + 1 pending on the active apartment doc).
    const before = await svc.getProgress(ctx(FULL()));
    // Seed an ARCHIVED apartment-level doc of this project + a SIGNED request
    // on it. Per D.57 it is superseded consent and must be excluded — uniform
    // with the tenant portal (portal.s4 #9).
    await withTenant(orgA.id, async (tx) => {
      const [d] = await tx
        .insert(documents)
        .values({
          orgId: orgA.id,
          apartmentId: fx.apartmentId,
          name: 'Superseded Agreement',
          type: 'contract',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          r2Key: `org/${orgA.id}/doc/${randomUUID()}.pdf`,
          contentHash: 'sha256:' + 'a'.repeat(64),
          uploadedBy: orgA.users[0]!.id,
          archivedAt: new Date(),
        })
        .returning({ id: documents.id });
      await tx.insert(signatureRequests).values({
        orgId: orgA.id,
        documentId: d!.id,
        ownerId: fx.ownerId,
        jti: `jti-${randomUUID()}`,
        status: 'signed',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdBy: orgA.users[0]!.id,
      });
    });
    const after = await svc.getProgress(ctx(FULL()));
    expect(after.signaturesSigned).toBe(before.signaturesSigned);
    expect(after.signaturesTotal).toBe(before.signaturesTotal);
    expect(after.signaturesPending).toBe(before.signaturesPending);
  });
});

describe('D2-DEF-1 — contractor getDocuments (project-level only)', () => {
  it('returns the project-level doc; EXCLUDES the per-owner (apartment) agreement', async () => {
    const { data } = await svc.getDocuments(ctx(FULL()));
    const ids = data.map((d) => d.id);
    expect(ids).toContain(fx.projectDocId);
    expect(ids).not.toContain(fx.apartmentDocId); // per-owner agreement excluded
    expect(ids).not.toContain(fx.otherProjectDocId); // other project excluded
  });

  it('documents OFF → 403', async () => {
    await expect(
      svc.getDocuments(ctx({ ...FULL(), documents: { on: false, actions: { download: false } } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('D2-DEF-1 — contractor download IDOR', () => {
  it('in-scope project doc → presigned URL', async () => {
    const r = await svc.getDownloadUrl(ctx(FULL()), fx.projectDocId);
    expect(r.url).toContain('https://r2.test/download');
  });

  it('per-owner (apartment-linked) doc → 404 (IDOR-safe, never minted)', async () => {
    await expect(svc.getDownloadUrl(ctx(FULL()), fx.apartmentDocId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('another project doc → 404 (IDOR-safe)', async () => {
    await expect(svc.getDownloadUrl(ctx(FULL()), fx.otherProjectDocId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('download capability OFF → 403', async () => {
    await expect(
      svc.getDownloadUrl(
        ctx({ ...FULL(), documents: { on: true, actions: { download: false } } }),
        fx.projectDocId,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
