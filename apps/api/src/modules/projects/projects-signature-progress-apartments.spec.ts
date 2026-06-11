/**
 * PHASE-6 "תמונת מצב" — PER-APARTMENT DRILL-DOWN (S5d, read-only) — INDEPENDENT
 * acceptance spec authored from the SPEC, BEFORE the builder. Does NOT touch the
 * implementation. RED against the CURRENT code (the new
 * `signatureProgressApartments(...)` service method / `GET
 * /api/v1/projects/:id/signature-progress/apartments` route does not exist yet)
 * and GREEN after the builder lands it.
 *
 * ── THE DRILL-DOWN (read-only) ─────────────────────────────────────────────
 * A NEW project-scoped endpoint returning a LIST of per-apartment rows, each
 * with exactly these 6 fields (NO owner PII):
 *   { apartmentId, number, floor, totalOwners, signedOwners,
 *     status: 'consented' | 'partial' | 'none' }
 *
 * status derivation (mirrors the 5a board's per-apartment consent, but ternary
 * instead of binary):
 *   status = (totalOwners > 0 && signedOwners === totalOwners) ? 'consented'
 *          : signedOwners > 0                                   ? 'partial'
 *          :                                                      'none'
 *
 * CONSENT DEFINITION (identical to 5a): an owner "signed" = a signature_request
 * with status='signed' on a PROJECT document, where the owner is an ACTIVE
 * ownership (ended_at IS NULL AND relationship='owner') of the apartment. The
 * join the builder MUST match:
 *   ownerships o (ended_at IS NULL, relationship='owner')
 *     EXISTS (signature_requests sr JOIN documents d ON d.id = sr.document_id
 *             WHERE sr.owner_id = o.owner_id AND sr.status='signed'
 *               AND d.project_id = <projectId>)
 *
 * NO PII: rows carry only counts + apartment designation (number/floor) — no
 * owner names, no national_id, no owner ids.
 *
 * SCOPING: withTenant org-scoped (cross-org id → no-oracle 404). Agents see ONLY
 * assigned projects (an unassigned agent → 404). Mirrors ProjectsService.get().
 *
 * ── HOW THE DRILL-DOWN IS DRIVEN (service-level, real DB) ───────────────────
 * This suite calls `ProjectsService.signatureProgressApartments(user, projectId)`
 * directly (the dominant in-repo pattern), via the `callApartments` adapter — a
 * structural cast so the FILE COMPILES today while the method is absent; calling
 * an undefined method then throws at RUNTIME (the intended RED). If the builder
 * names the method differently, ONLY the adapter changes; the assertions are the
 * contract.
 *
 * ── SEEDING HARNESS ────────────────────────────────────────────────────────
 * Mirrors projects-signature-progress.spec.ts EXACTLY (proven), incl.
 * `seedEqualOwnerships` for atomic multi-owner seeding (the S3b deferred-trigger
 * lesson — the DEFERRABLE INITIALLY DEFERRED ownership-sum trigger evaluates ONCE
 * at COMMIT over the complete 100% set), `seedProjectDoc`, and SIGNED vs PENDING
 * signature_requests tied to owner+project-doc.
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, providerPool } from '../../../../../packages/db/src/client';
import { memberships, users } from '../../../../../packages/db/src/schema/tenancy';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** A single per-apartment drill-down row (the 6 fields, NO PII). */
interface ApartmentProgressRow {
  apartmentId: string;
  number: string;
  floor: number | null;
  totalOwners: number;
  signedOwners: number;
  status: 'consented' | 'partial' | 'none';
}

/**
 * Call the (not-yet-existing) drill-down method. Structural cast so the file
 * COMPILES before the builder adds `signatureProgressApartments`; at runtime,
 * calling an undefined method throws → the intended RED for test #1. If the
 * builder names it differently, change ONLY this adapter.
 */
async function callApartments(
  svc: ProjectsService,
  user: AccessTokenPayload,
  projectId: string,
): Promise<ApartmentProgressRow[]> {
  const fn = (svc as unknown as Record<string, unknown>)['signatureProgressApartments'];
  if (typeof fn !== 'function') {
    throw new Error(
      'ProjectsService.signatureProgressApartments is not implemented (route/method missing)',
    );
  }
  return (fn as (u: AccessTokenPayload, p: string) => Promise<ApartmentProgressRow[]>).call(
    svc,
    user,
    projectId,
  );
}

let svc: ProjectsService;
let org: TestOrg;
let managerId: string;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000e1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function agentFor(agentId: string): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: '00000000-0000-4000-8000-0000000000e2',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

let nidCounter = 300000001;
function natId(): string {
  return String(nidCounter++);
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

/** Apartment with a chosen `number` + `floor` so the drill-down designation is
 *  assertable. `number` is the human label (D.39: entity is "apartment"). */
async function seedApartment(
  buildingId: string,
  number: string,
  floor: number | null,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number, floor) VALUES ($1, $2, $3) RETURNING id`,
      [buildingId, number, floor],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Owner with REAL PII (encrypted) so the no-PII assertion is meaningful — if
 *  the response leaked names/national_id it would surface the seeded values. */
async function seedOwner(
  orgId: string,
  pii: { nationalId: string; name: string; phone: string },
): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const enc = await encryptOwnerPii(tx as never, pii);
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        email: `owner-${randomUUID()}@test.local`,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Active `owner` ownership at a chosen pct (default 100 → sum trigger happy). */
async function seedOwnership(apartmentId: string, ownerId: string, pct = 100): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship)
       VALUES ($1, $2, $3, 'owner')`,
      [apartmentId, ownerId, pct.toFixed(2)],
    );
  } finally {
    c.release();
  }
}

/** Seed N co-owners on one apartment with EQUAL exact fractions (1/N each), in a
 *  SINGLE transaction so the DEFERRABLE INITIALLY DEFERRED ownership-sum trigger
 *  evaluates ONCE over the complete 100% set (autocommit per-owner would trip
 *  5000/10000≠1 on the first insert — the S3b deferred-trigger lesson). */
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

/** Finalised project-scoped document (uploaded_at set). The project's signature doc. */
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

/** A signature_request in a chosen terminal status, tied to (document, owner). */
async function seedRequest(
  orgId: string,
  documentId: string,
  ownerId: string,
  status: 'signed' | 'pending' | 'cancelled' | 'expired',
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests
         (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        orgId,
        documentId,
        ownerId,
        'jti-drill-' + randomUUID(),
        status,
        new Date(Date.now() + SEVEN_DAYS_MS),
        managerId,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedAgentUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `agent-${randomUUID()}@test.local`,
      name: 'Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId: org.id, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Helper: find the drill-down row for a known apartment id. */
function rowFor(
  rows: ApartmentProgressRow[],
  apartmentId: string,
): ApartmentProgressRow | undefined {
  return rows.find((r) => r.apartmentId === apartmentId);
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  const tag = `sig-drill-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// #1 — the drill-down returns per-apartment rows with the 6 fields
//      (RED now: method/route missing)
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress drill-down — shape', () => {
  it('returns per-apartment rows each with the 6 fields', async () => {
    const projectId = org.projects[0]!.id;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'A1', 2);
    const owner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    await seedOwnership(apt, owner);
    const doc = await seedProjectDoc(org.id, projectId);
    await seedRequest(org.id, doc, owner, 'signed');

    const rows = await callApartments(svc, manager(), projectId);

    expect(Array.isArray(rows)).toBe(true);
    const row = rowFor(rows, apt);
    expect(row).toBeDefined();
    // All 6 fields present + correctly typed.
    expect(typeof row!.apartmentId).toBe('string');
    expect(typeof row!.number).toBe('string');
    expect(row!.floor === null || typeof row!.floor === 'number').toBe(true);
    expect(typeof row!.totalOwners).toBe('number');
    expect(typeof row!.signedOwners).toBe('number');
    expect(['consented', 'partial', 'none']).toContain(row!.status);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #2 — per-apartment correctness: consented / partial / none + counts + label
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress drill-down — per-apartment correctness', () => {
  it('apt A(1 owner signed)=consented; apt B(2 owners,1 signed)=partial; apt C(1 owner pending)=none', async () => {
    const projectId = org.projects[1]!.id;
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    // apt A — number 'A', floor 1, 1 owner, SIGNED → consented (1/1).
    const aptA = await seedApartment(building, 'A', 1);
    const aOwner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'אבי',
      phone: '0540000001',
    });
    await seedOwnership(aptA, aOwner);
    await seedRequest(org.id, doc, aOwner, 'signed');

    // apt B — number 'B', floor 2, 2 owners (50/50), only ONE signed → partial (1/2).
    const aptB = await seedApartment(building, 'B', 2);
    const bOwner1 = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'בני',
      phone: '0540000002',
    });
    const bOwner2 = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'גדי',
      phone: '0540000003',
    });
    await seedEqualOwnerships(aptB, [bOwner1, bOwner2]);
    await seedRequest(org.id, doc, bOwner1, 'signed'); // only owner1 signed
    await seedRequest(org.id, doc, bOwner2, 'pending'); // owner2 still pending

    // apt C — number 'C', floor 3, 1 owner, PENDING only → none (0/1).
    const aptC = await seedApartment(building, 'C', 3);
    const cOwner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'דנה',
      phone: '0540000004',
    });
    await seedOwnership(aptC, cOwner);
    await seedRequest(org.id, doc, cOwner, 'pending');

    const rows = await callApartments(svc, manager(), projectId);

    const rowA = rowFor(rows, aptA);
    const rowB = rowFor(rows, aptB);
    const rowC = rowFor(rows, aptC);

    // All three apartments are present in the list.
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect(rowC).toBeDefined();

    // apt A — consented, 1/1, designation A/floor 1.
    expect(rowA!.number).toBe('A');
    expect(rowA!.floor).toBe(1);
    expect(rowA!.totalOwners).toBe(1);
    expect(rowA!.signedOwners).toBe(1);
    expect(rowA!.status).toBe('consented');

    // apt B — partial, 1/2, designation B/floor 2.
    expect(rowB!.number).toBe('B');
    expect(rowB!.floor).toBe(2);
    expect(rowB!.totalOwners).toBe(2);
    expect(rowB!.signedOwners).toBe(1);
    expect(rowB!.status).toBe('partial');

    // apt C — none, 0/1, designation C/floor 3.
    expect(rowC!.number).toBe('C');
    expect(rowC!.floor).toBe(3);
    expect(rowC!.totalOwners).toBe(1);
    expect(rowC!.signedOwners).toBe(0);
    expect(rowC!.status).toBe('none');
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #3 — NO owner PII leaks into the drill-down (counts + designation only)
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress drill-down — no owner PII', () => {
  it('rows carry no owner name / national_id / owner id (apartment-level counts only)', async () => {
    const projectId = org.projects[0]!.id;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'PII-1', 5);
    const secretNatId = natId();
    const secretName = 'סודי-בעלים-ייחודי';
    const secretPhone = '0549998877';
    const owner = await seedOwner(org.id, {
      nationalId: secretNatId,
      name: secretName,
      phone: secretPhone,
    });
    await seedOwnership(apt, owner);
    const doc = await seedProjectDoc(org.id, projectId);
    await seedRequest(org.id, doc, owner, 'signed');

    const rows = await callApartments(svc, manager(), projectId);
    const row = rowFor(rows, apt);
    expect(row).toBeDefined();

    // The owner id, national_id, name, and phone must NOT appear anywhere in the
    // row — neither as a top-level field nor nested. Serialise the row and scan.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(owner); // owner id absent
    expect(serialised).not.toContain(secretNatId); // national_id absent
    expect(serialised).not.toContain(secretName); // owner name absent
    expect(serialised).not.toContain(secretPhone); // phone absent

    // And the field set is exactly the 6 contract fields (no extra owner-y keys).
    expect(Object.keys(row!).sort()).toEqual(
      ['apartmentId', 'floor', 'number', 'signedOwners', 'status', 'totalOwners'].sort(),
    );
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #4 — scoping: cross-org 404; unassigned agent 404 (no oracle)
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress drill-down — scoping', () => {
  it('a project in ANOTHER org → 404 (not visible, no oracle)', async () => {
    const otherTag = `sig-drill-other-${Date.now()}`;
    const otherOrg = await createTestOrg(otherTag, otherTag);
    const otherProjectId = otherOrg.projects[0]!.id;

    await expect(callApartments(svc, manager(), otherProjectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);

  it('an AGENT NOT assigned to the project → 404', async () => {
    const projectId = org.projects[0]!.id;
    const unassignedAgent = await seedAgentUser(); // no project_assignments row

    await expect(callApartments(svc, agentFor(unassignedAgent), projectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);
});
