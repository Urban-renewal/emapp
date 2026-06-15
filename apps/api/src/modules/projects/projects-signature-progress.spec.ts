/**
 * PHASE-6 "תמונת מצב" — PROJECT SIGNATURE-PROGRESS BOARD (S5a) — INDEPENDENT
 * acceptance spec authored from the SPEC, BEFORE the builder. Does NOT touch
 * the implementation. RED against the CURRENT code (the new
 * `signatureProgress(...)` service method / `GET
 * /api/v1/projects/:id/signature-progress` route does not exist yet) and GREEN
 * after the builder lands it.
 *
 * ── THE BOARD (read-only) ──────────────────────────────────────────────────
 * A NEW project-scoped board returning the 7 fields:
 *   { totalApartments, apartmentsConsented, signaturesSigned, signaturesPending,
 *     targetSignaturePct, consentedPct, metThreshold }
 *
 * apartmentsConsented (v1, the genuinely-new logic):
 *   an apartment is CONSENTED iff EVERY active owner of that apartment
 *   (ownerships.ended_at IS NULL AND relationship='owner') has a SIGNED
 *   signature-request (signature_requests.status='signed' tied to that owner on
 *   one of the project's signature docs). BINARY per apartment (NOT
 *   share-weighted). An apartment with NO active owners is NOT consented.
 *
 *   consentedPct = totalApartments ? round(apartmentsConsented/total*100) : 0
 *   metThreshold = targetSignaturePct != null && consentedPct >= targetSignaturePct
 *
 * SCOPING: withTenant org-scoped (cross-org id → 404). Agents see ONLY assigned
 * projects (an unassigned agent → 404). Mirrors ProjectsService.get().
 *
 * ── HOW THE BOARD IS DRIVEN (service-level, real DB) ───────────────────────
 * This suite calls `ProjectsService.signatureProgress(user, projectId)`
 * directly (the dominant in-repo pattern: see
 * projects-orgstats-agent-scope.spec.ts / signature-requests-correctness.spec.ts).
 * It deliberately references the method by a structural cast so the FILE
 * COMPILES today while the method is absent — the call then throws/has no
 * route at RUNTIME, which is the intended RED. If the builder names the method
 * differently, only the `callBoard` adapter below needs a one-line change; the
 * assertions are the contract.
 *
 * ── SEEDING HARNESS (mirrored) ─────────────────────────────────────────────
 * createTestOrg(tag) → org + manager + 2 projects (factories.ts). Everything
 * below is seeded via providerPool (BYPASSRLS) so ground-truth is org-context
 * independent, EXACTLY like signature-requests-correctness.spec.ts:
 *   - building  : INSERT buildings(project_id,address,city)
 *   - apartment : INSERT apartments(building_id,number)
 *   - owner     : encryptOwnerPii + INSERT owners (withTenant)
 *   - ownership : INSERT ownerships(apartment_id,owner_id,ownership_pct=100,
 *                 relationship='owner')   ← the active-owner bond the board reads
 *   - doc       : INSERT documents(... project_id, uploaded_at=now())  (finalised,
 *                 project-scoped — the project's signature doc)
 *   - signed req: INSERT signature_requests(org_id,document_id,owner_id,jti,
 *                 status='signed',expires_at,created_by)   ← ties an OWNER to a
 *                 SIGNED request on the project's doc. THIS join (owner_id on a
 *                 request whose document_id is one of the project's docs) is what
 *                 "this owner signed" means for the board — the builder's query
 *                 MUST match it.
 *   - pending req: same, status='pending'.
 *
 * NOTE (D.65 ownership-sum trigger): every apartment that has an `owner`
 * ownership row must sum to 100% at COMMIT. The 2-owner apartment (apt B) gives
 * each owner 50% so the sum is exactly 100.
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

/** The board shape the builder must return (all 7 fields). */
interface SignatureProgressBoard {
  totalApartments: number;
  apartmentsConsented: number;
  signaturesSigned: number;
  signaturesPending: number;
  targetSignaturePct: number | null;
  consentedPct: number;
  metThreshold: boolean;
}

/**
 * Call the (not-yet-existing) board method. Structural cast so the file
 * COMPILES before the builder adds `signatureProgress`; at runtime, calling an
 * undefined method throws → that is the intended RED for test #1. If the
 * builder names it differently, change ONLY this adapter.
 */
async function callBoard(
  svc: ProjectsService,
  user: AccessTokenPayload,
  projectId: string,
): Promise<SignatureProgressBoard> {
  const fn = (svc as unknown as Record<string, unknown>)['signatureProgress'];
  if (typeof fn !== 'function') {
    throw new Error('ProjectsService.signatureProgress is not implemented (route/method missing)');
  }
  return (fn as (u: AccessTokenPayload, p: string) => Promise<SignatureProgressBoard>).call(
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
    sid: '00000000-0000-4000-8000-0000000000d1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function agentFor(agentId: string): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: '00000000-0000-4000-8000-0000000000d2',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

let nidCounter = 200000001;
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
        'jti-board-' + randomUUID(),
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

/** Set a project's targetSignaturePct directly (board reads it; null clears). */
async function setTarget(projectId: string, pct: number | null): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE projects SET target_signature_pct = $2 WHERE id = $1`, [
      projectId,
      pct === null ? null : pct.toFixed(2),
    ]);
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

/** Active project assignment (the bond `assertProjectVisible`'s agent branch reads). */
async function assignAgent(projectId: string, agentId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO project_assignments (project_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
      [projectId, agentId, managerId],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  const tag = `sig-progress-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// #1 — the board returns all 7 fields (RED now: method/route missing)
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress board — shape', () => {
  it('returns all 7 board fields for a project', async () => {
    const projectId = org.projects[0]!.id;
    const building = await seedBuilding(projectId);
    const apartment = await seedApartment(building);
    const owner = await seedOwner(org.id);
    await seedOwnership(apartment, owner);
    const doc = await seedProjectDoc(org.id, projectId);
    await seedRequest(org.id, doc, owner, 'signed');

    const board = await callBoard(svc, manager(), projectId);

    // All 7 fields present and correctly typed.
    expect(typeof board.totalApartments).toBe('number');
    expect(typeof board.apartmentsConsented).toBe('number');
    expect(typeof board.signaturesSigned).toBe('number');
    expect(typeof board.signaturesPending).toBe('number');
    expect(board.targetSignaturePct === null || typeof board.targetSignaturePct === 'number').toBe(
      true,
    );
    expect(typeof board.consentedPct).toBe('number');
    expect(typeof board.metThreshold).toBe('boolean');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #2 — apartmentsConsented correctness (binary per apartment, every owner signed)
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress board — apartmentsConsented (binary per apartment)', () => {
  it('apt A(1 owner signed)=consented; apt B(2 owners,1 signed)=not; apt C(1 owner pending)=not → consented=1, total=3, pct=33', async () => {
    const projectId = org.projects[1]!.id;
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    // apt A — 1 owner, SIGNED → consented.
    const aptA = await seedApartment(building);
    const aOwner = await seedOwner(org.id);
    await seedOwnership(aptA, aOwner);
    await seedRequest(org.id, doc, aOwner, 'signed');

    // apt B — 2 owners (50/50), only ONE signed → NOT consented.
    const aptB = await seedApartment(building);
    const bOwner1 = await seedOwner(org.id);
    const bOwner2 = await seedOwner(org.id);
    await seedEqualOwnerships(aptB, [bOwner1, bOwner2]);
    await seedRequest(org.id, doc, bOwner1, 'signed'); // only owner1 signed
    await seedRequest(org.id, doc, bOwner2, 'pending'); // owner2 still pending

    // apt C — 1 owner, PENDING only → NOT consented.
    const aptC = await seedApartment(building);
    const cOwner = await seedOwner(org.id);
    await seedOwnership(aptC, cOwner);
    await seedRequest(org.id, doc, cOwner, 'pending');

    const board = await callBoard(svc, manager(), projectId);

    expect(board.totalApartments).toBe(3);
    expect(board.apartmentsConsented).toBe(1); // ONLY apt A
    expect(board.consentedPct).toBe(33); // round(1/3*100)
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #3 — metThreshold against targetSignaturePct
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress board — metThreshold', () => {
  async function seedThirtyThreeProject(): Promise<string> {
    // A fresh project with consentedPct == 33 (1 of 3 apartments consented).
    const projectId = await withTenant(org.id, async (tx) => {
      const { projects } = await import('@emapp/db');
      const [p] = await tx
        .insert(projects)
        .values({
          orgId: org.id,
          name: `threshold-${randomUUID().slice(0, 6)}`,
          type: 'tama38_1',
          createdBy: managerId,
        })
        .returning({ id: projects.id });
      return p!.id;
    });
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    const consented = await seedApartment(building);
    const cOwner = await seedOwner(org.id);
    await seedOwnership(consented, cOwner);
    await seedRequest(org.id, doc, cOwner, 'signed');

    for (let i = 0; i < 2; i += 1) {
      const apt = await seedApartment(building);
      const o = await seedOwner(org.id);
      await seedOwnership(apt, o);
      await seedRequest(org.id, doc, o, 'pending');
    }
    return projectId;
  }

  it('target=33 → metThreshold TRUE at consentedPct=33 (>=)', async () => {
    const projectId = await seedThirtyThreeProject();
    await setTarget(projectId, 33);

    const board = await callBoard(svc, manager(), projectId);
    expect(board.consentedPct).toBe(33);
    expect(board.targetSignaturePct).toBe(33);
    expect(board.metThreshold).toBe(true);
  }, 60_000);

  it('target=66 → metThreshold FALSE at consentedPct=33 (<)', async () => {
    const projectId = await seedThirtyThreeProject();
    await setTarget(projectId, 66);

    const board = await callBoard(svc, manager(), projectId);
    expect(board.consentedPct).toBe(33);
    expect(board.targetSignaturePct).toBe(66);
    expect(board.metThreshold).toBe(false);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #4 — empty project (0 apartments) → no divide-by-zero
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress board — empty project', () => {
  it('0 apartments → total=0, consented=0, consentedPct=0, metThreshold false (no div-by-zero)', async () => {
    const projectId = await withTenant(org.id, async (tx) => {
      const { projects } = await import('@emapp/db');
      const [p] = await tx
        .insert(projects)
        .values({
          orgId: org.id,
          name: `empty-${randomUUID().slice(0, 6)}`,
          type: 'tama38_1',
          createdBy: managerId,
        })
        .returning({ id: projects.id });
      return p!.id;
    });
    // Give it a target so metThreshold has a non-null target but still false at 0%.
    await setTarget(projectId, 66);

    const board = await callBoard(svc, manager(), projectId);

    expect(board.totalApartments).toBe(0);
    expect(board.apartmentsConsented).toBe(0);
    expect(board.consentedPct).toBe(0); // guarded, not NaN
    expect(Number.isNaN(board.consentedPct)).toBe(false);
    expect(board.metThreshold).toBe(false);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #5 — scoping: cross-org 404; unassigned agent 404
// ───────────────────────────────────────────────────────────────────────────
describe('signature-progress board — scoping', () => {
  it('a project in ANOTHER org → 404 (not visible, no oracle)', async () => {
    const otherTag = `sig-progress-other-${Date.now()}`;
    const otherOrg = await createTestOrg(otherTag, otherTag);
    const otherProjectId = otherOrg.projects[0]!.id;

    // Manager of `org` asking for `otherOrg`'s project → no-oracle 404.
    await expect(callBoard(svc, manager(), otherProjectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);

  it('an AGENT NOT assigned to the project → 404', async () => {
    const projectId = org.projects[0]!.id;
    const unassignedAgent = await seedAgentUser(); // no project_assignments row

    await expect(callBoard(svc, agentFor(unassignedAgent), projectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);

  it('an AGENT ASSIGNED to the project → board returns (allow-path, no false 404)', async () => {
    // Exercises the ALLOW side of assertProjectVisible's agent inner-join
    // (the unassigned case above only proves the DENY side).
    const projectId = org.projects[1]!.id;
    const assignedAgent = await seedAgentUser();
    await assignAgent(projectId, assignedAgent);

    const board = await callBoard(svc, agentFor(assignedAgent), projectId);
    expect(typeof board.totalApartments).toBe('number');
    expect(typeof board.metThreshold).toBe('boolean');
  }, 60_000);
});
