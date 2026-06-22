/**
 * CORE-FLOW REGRESSION — a SIGNED signature on an APARTMENT-SCOPED agreement
 * document must advance the project's progress (consentedPct / signaturesSigned).
 *
 * ROOT CAUSE (live-verified): owners sign their APARTMENT's agreement doc, which
 * is apartment-scoped — `documents.apartment_id` is set and `documents.project_id`
 * is NULL or points at a DIFFERENT project (the doc create writes
 * `projectId: input.projectId ?? null`). The board/KPI/leverage/holdout joins
 * detected "this owner signed for this project" via the bare
 * `documents.project_id = <projectId>` join, so an apartment-doc signature was
 * MISSED entirely → consentedPct stayed 0 and signaturesSigned stayed 0 even
 * after the tenant signed.
 *
 * THE FIX: a signed/pending request counts for a project when its document is
 * associated EITHER project-level (d.project_id) OR via the doc's apartment
 * (d.apartment_id → apartments → buildings → project) — the canonical
 * `projectSignatureDocIdsSql` resolution. This suite proves:
 *   (1) signing an apartment-scoped doc (project_id NULL) MOVES the board;
 *   (2) signing an apartment-scoped doc whose project_id points at ANOTHER
 *       project still counts for the apartment's REAL project (project_id is
 *       irrelevant once apartment_id resolves);
 *   (3) the project-level (d.project_id) path STILL counts (behaviour-preserving);
 *   (4) NO CROSS-PROJECT LEAK: a signed apartment-doc whose apartment is in a
 *       DIFFERENT project does NOT advance this project.
 *
 * Seeding mirrors projects-signature-progress.spec.ts (providerPool / BYPASSRLS
 * ground-truth). No PII assertions are needed — the board returns only counts.
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface SignatureProgressBoard {
  totalApartments: number;
  apartmentsConsented: number;
  signaturesSigned: number;
  signaturesPending: number;
  targetSignaturePct: number | null;
  consentedPct: number;
  metThreshold: boolean;
  basis: 'share';
}

let svc: ProjectsService;
let org: TestOrg;
let managerId: string;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000d1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function callBoard(projectId: string): Promise<SignatureProgressBoard> {
  return (
    svc as unknown as {
      signatureProgress: (u: AccessTokenPayload, p: string) => Promise<SignatureProgressBoard>;
    }
  ).signatureProgress(manager(), projectId);
}

let nidCounter = 500000001;
function natId(): string {
  return String(nidCounter++);
}

/** A fresh project in the test org, so each scenario's counts are isolated. */
async function seedProject(): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, created_by)
       VALUES ($1, $2, 'tama38_1', $3) RETURNING id`,
      [org.id, `aptdoc-${randomUUID()}`, managerId],
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

async function seedOwner(): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
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

async function seedOwnership(apartmentId: string, ownerId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, '100.00', 'owner')`,
      [apartmentId, ownerId],
    );
  } finally {
    c.release();
  }
}

/**
 * Finalised APARTMENT-scoped agreement document. `apartment_id` is set;
 * `project_id` is whatever the caller passes (NULL for the canonical
 * apartment-scoped doc, or a DIFFERENT project's id to prove project_id is
 * irrelevant once apartment_id resolves). doc_scope/doc_scope_id are derived
 * server-side in prod; here we set them explicitly to satisfy the
 * documents_doc_scope_id_consistent CHECK.
 */
async function seedApartmentDoc(apartmentId: string, projectId: string | null): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, apartment_id, name, type, mime_type, size_bytes, r2_key,
          content_hash, uploaded_by, uploaded_at, doc_scope, doc_scope_id)
       VALUES ($1, $2, $3, 'agreement.pdf', 'agreement', 'application/pdf', 100, $4, 'h', $5, now(),
               'apartment', $3)
       RETURNING id`,
      [org.id, projectId, apartmentId, `org/${org.id}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Finalised PROJECT-scoped document (the behaviour-preserving control). */
async function seedProjectDoc(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash,
          uploaded_by, uploaded_at, doc_scope, doc_scope_id)
       VALUES ($1, $2, 'plan.pdf', 'agreement', 'application/pdf', 100, $3, 'h', $4, now(),
               'project', $2)
       RETURNING id`,
      [org.id, projectId, `org/${org.id}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedRequest(
  documentId: string,
  ownerId: string,
  status: 'signed' | 'pending',
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO signature_requests
         (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        org.id,
        documentId,
        ownerId,
        'jti-aptdoc-' + randomUUID(),
        status,
        new Date(Date.now() + SEVEN_DAYS_MS),
        managerId,
      ],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  const tag = `sig-aptdoc-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('signature-progress — apartment-scoped doc advances the project', () => {
  it('a SIGNED apartment-scoped doc (project_id NULL) moves consentedPct + signaturesSigned', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const apartment = await seedApartment(building);
    const owner = await seedOwner();
    await seedOwnership(apartment, owner);

    // Apartment-scoped agreement doc — project_id NULL (the canonical shape).
    const doc = await seedApartmentDoc(apartment, null);

    const before = await callBoard(projectId);
    expect(before.signaturesSigned).toBe(0);
    expect(before.consentedPct).toBe(0);

    await seedRequest(doc, owner, 'signed');

    const after = await callBoard(projectId);
    // The signature now COUNTS: the single owner of the single apartment signed,
    // so the apartment is fully consented → consentedPct 100, signaturesSigned 1.
    expect(after.signaturesSigned).toBe(1);
    expect(after.consentedPct).toBe(100);
    expect(after.apartmentsConsented).toBe(1);
  }, 30_000);

  it('counts even when the apartment-doc project_id points at a DIFFERENT project', async () => {
    const realProject = await seedProject();
    const otherProject = await seedProject(); // a sibling project in the same org
    const building = await seedBuilding(realProject);
    const apartment = await seedApartment(building);
    const owner = await seedOwner();
    await seedOwnership(apartment, owner);

    // Apartment is in realProject; the doc's project_id wrongly points at
    // otherProject (the exact live-bug shape). The apartment path must win.
    const doc = await seedApartmentDoc(apartment, otherProject);
    await seedRequest(doc, owner, 'signed');

    const board = await callBoard(realProject);
    // The apartment is in realProject; even though the doc's project_id points
    // at otherProject, the apartment→project association still binds the signed
    // request to realProject. realProject (fresh, isolated) gets the count.
    expect(board.signaturesSigned).toBe(1);
    expect(board.apartmentsConsented).toBe(1);
    expect(board.consentedPct).toBe(100);

    // (otherProject DOES also count this signature — the doc carries a genuine
    // project_id = otherProject association — but otherProject has NO apartments,
    // so its consentedPct stays 0. This is dual-association, NOT a leak: the
    // cross-project LEAK guard is the separate test below, where the doc's
    // apartment is in another project and project_id is NULL.)
    const otherBoard = await callBoard(otherProject);
    expect(otherBoard.consentedPct).toBe(0);
  }, 30_000);

  it('PROJECT-level doc still counts (behaviour-preserving)', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const apartment = await seedApartment(building);
    const owner = await seedOwner();
    await seedOwnership(apartment, owner);

    const doc = await seedProjectDoc(projectId);
    await seedRequest(doc, owner, 'signed');

    const board = await callBoard(projectId);
    expect(board.signaturesSigned).toBe(1);
    expect(board.consentedPct).toBe(100);
    expect(board.apartmentsConsented).toBe(1);
  }, 30_000);

  it('NO CROSS-PROJECT LEAK: an apartment-doc signed in ANOTHER project does not advance this one', async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();

    // projectA: one apartment, one owner, signed on its OWN apartment doc.
    const buildingA = await seedBuilding(projectA);
    const apartmentA = await seedApartment(buildingA);
    const ownerA = await seedOwner();
    await seedOwnership(apartmentA, ownerA);
    const docA = await seedApartmentDoc(apartmentA, null);
    await seedRequest(docA, ownerA, 'signed');

    // projectB: one apartment, one owner, NO signature.
    const buildingB = await seedBuilding(projectB);
    const apartmentB = await seedApartment(buildingB);
    const ownerB = await seedOwner();
    await seedOwnership(apartmentB, ownerB);

    const boardB = await callBoard(projectB);
    // projectA's signed apartment doc must NOT bleed into projectB.
    expect(boardB.signaturesSigned).toBe(0);
    expect(boardB.consentedPct).toBe(0);
    expect(boardB.apartmentsConsented).toBe(0);
  }, 30_000);

  it('a PENDING apartment-scoped doc is counted in signaturesPending', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const apartment = await seedApartment(building);
    const owner = await seedOwner();
    await seedOwnership(apartment, owner);

    const doc = await seedApartmentDoc(apartment, null);
    await seedRequest(doc, owner, 'pending');

    const board = await callBoard(projectId);
    expect(board.signaturesPending).toBe(1);
    expect(board.signaturesSigned).toBe(0);
    // Pending is not consent — consentedPct stays 0.
    expect(board.consentedPct).toBe(0);
  }, 30_000);
});
