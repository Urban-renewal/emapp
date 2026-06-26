/**
 * AGENT-SCOPED home KPIs — real-DB scoping-correctness spec.
 *
 * ProjectsService.orgStats(user) branches on role:
 *   - manager/viewer → ORG-WIDE counts (active projects, residents, signed,
 *     pending).
 *   - agent → the SAME four counts scoped to the agent's ASSIGNED projects only
 *     (project_assignments WHERE user_id = sub AND unassigned_at IS NULL), with
 *     residents = distinct active owners reachable via the assigned projects'
 *     buildings→apartments→ownerships, and signatures = signature_requests whose
 *     document_id is in the assigned projects' signature docs (project-level ∪
 *     apartment-level, archived excluded) via projectSetSignatureDocIdsSql.
 *
 * The point of this spec is the NO-CROSS-PROJECT-LEAK invariant: an agent must
 * NOT see counts from an unassigned project (P3) nor from a project they were
 * unassigned from. Adversarial seed: P3 carries owners + signed/pending sigs
 * that would inflate the agent's numbers if scoping leaked.
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  documents,
  encryptOwnerPii,
  owners,
  ownerships,
  projectAssignments,
  projects,
  signatureRequests,
  withTenant,
} from '@emapp/db';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { db } from '../../../../../packages/db/src/client';
import { memberships, users } from '../../../../../packages/db/src/schema/tenancy';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

let svc: ProjectsService;
let org: TestOrg;
let managerId: string;
let agentId: string; // assigned to P1, P2
let agentZeroId: string; // assigned to nothing

// Three projects (P1, P2 assigned to agent; P3 NOT assigned).
const P: { p1: string; p2: string; p3: string } = { p1: '', p2: '', p3: '' };

const MGR_SID = '00000000-0000-4000-8000-0000000000a1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000a2';
const AGENT0_SID = '00000000-0000-4000-8000-0000000000a3';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
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
function agentZero(): AccessTokenPayload {
  return {
    sub: agentZeroId,
    orgId: org.id,
    role: 'agent',
    sid: AGENT0_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

async function seedAgentUser(role: 'agent'): Promise<string> {
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
    .values({ userId: u!.id, orgId: org.id, role, acceptedAt: new Date() });
  return u!.id;
}

let nidCounter = 100000009;
/** Seed an owner with a UNIQUE national_id and an ACTIVE ownership on `aptId`. */
async function seedOwnerWithOwnership(aptId: string): Promise<string> {
  const nid = String(nidCounter++);
  return withTenant(org.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as never, {
      name: `בעלים ${nid}`,
      nationalId: nid,
      phone: '050' + nid.slice(2),
    });
    const [own] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
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
      .values({ apartmentId: aptId, ownerId: own!.id, ownershipPct: '100', role: 'owner' });
    return own!.id;
  });
}

/** Building + one apartment under a project; returns the apartment id. */
async function seedBuildingApartment(projectId: string): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [b] = await tx
      .insert(buildings)
      .values({ projectId, address: `Herzl ${randomUUID().slice(0, 4)}`, city: 'Tel Aviv' })
      .returning({ id: buildings.id });
    const [a] = await tx
      .insert(apartments)
      .values({
        buildingId: b!.id,
        number: String(Math.floor(Math.random() * 9000) + 1000),
        floor: 1,
      })
      .returning({ id: apartments.id });
    return a!.id;
  });
}

/** Project-level doc. */
async function seedProjectDoc(projectId: string, archived = false): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [d] = await tx
      .insert(documents)
      .values({
        orgId: org.id,
        projectId,
        name: 'Project Plan',
        type: 'contract',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        r2Key: `org/${org.id}/doc/${randomUUID()}.pdf`,
        contentHash: 'sha256:' + 'd'.repeat(64),
        uploadedBy: managerId,
        uploadedAt: new Date(),
        archivedAt: archived ? new Date() : null,
      })
      .returning({ id: documents.id });
    return d!.id;
  });
}

/** Apartment-level (per-owner) doc. */
async function seedApartmentDoc(apartmentId: string): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [d] = await tx
      .insert(documents)
      .values({
        orgId: org.id,
        apartmentId,
        name: 'Owner Agreement',
        type: 'contract',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        r2Key: `org/${org.id}/doc/${randomUUID()}.pdf`,
        contentHash: 'sha256:' + 'e'.repeat(64),
        uploadedBy: managerId,
        uploadedAt: new Date(),
      })
      .returning({ id: documents.id });
    return d!.id;
  });
}

async function seedSig(
  documentId: string,
  ownerId: string,
  status: 'signed' | 'pending' | 'cancelled',
): Promise<void> {
  await withTenant(org.id, async (tx) => {
    await tx.insert(signatureRequests).values({
      orgId: org.id,
      documentId,
      ownerId,
      jti: `jti-${randomUUID()}`,
      status,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdBy: managerId,
    });
  });
}

// Tally of what we seed so the assertions read off a single source of truth.
const expected = {
  agent: { activeProjects: 2, residents: 0, signaturesReceived: 0, signaturesPending: 0 },
  manager: { activeProjects: 3, residents: 0, signaturesReceived: 0, signaturesPending: 0 },
};

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  const tag = `orgstats-agent-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;

  // createTestOrg seeds 2 projects; add a 3rd (P3 — unassigned).
  P.p1 = org.projects[0]!.id;
  P.p2 = org.projects[1]!.id;
  P.p3 = await withTenant(org.id, async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ orgId: org.id, name: `${tag} Project 3`, type: 'tama38_1', createdBy: managerId })
      .returning({ id: projects.id });
    return p!.id;
  });

  agentId = await seedAgentUser('agent');
  agentZeroId = await seedAgentUser('agent');

  // Assign the agent to P1 and P2 only (active rows). P3 is left unassigned.
  await db.insert(projectAssignments).values([
    { projectId: P.p1, userId: agentId, assignedBy: managerId },
    { projectId: P.p2, userId: agentId, assignedBy: managerId },
  ]);

  // ----- P1: 2 distinct owners; 1 project-level doc, 1 apartment-level doc.
  const p1apt = await seedBuildingApartment(P.p1);
  const p1ownerA = await seedOwnerWithOwnership(p1apt);
  const p1apt2 = await seedBuildingApartment(P.p1);
  const p1ownerB = await seedOwnerWithOwnership(p1apt2);
  const p1ProjDoc = await seedProjectDoc(P.p1);
  const p1AptDoc = await seedApartmentDoc(p1apt);
  // P1 project-level doc: 2 signed, 1 pending, 1 cancelled.
  await seedSig(p1ProjDoc, p1ownerA, 'signed');
  await seedSig(p1ProjDoc, p1ownerB, 'signed');
  await seedSig(p1ProjDoc, p1ownerA, 'pending');
  await seedSig(p1ProjDoc, p1ownerB, 'cancelled');
  // P1 apartment-level doc: 1 signed, 1 pending (MUST be included via apt path).
  await seedSig(p1AptDoc, p1ownerA, 'signed');
  await seedSig(p1AptDoc, p1ownerA, 'pending');

  // ----- P2: 1 distinct owner; apartment-level doc only (proves apt docs count).
  const p2apt = await seedBuildingApartment(P.p2);
  const p2owner = await seedOwnerWithOwnership(p2apt);
  const p2AptDoc = await seedApartmentDoc(p2apt);
  await seedSig(p2AptDoc, p2owner, 'signed');
  await seedSig(p2AptDoc, p2owner, 'pending');
  await seedSig(p2AptDoc, p2owner, 'cancelled');

  // ----- P3 (UNASSIGNED): owners + signed/pending sigs that MUST NOT leak in.
  const p3apt = await seedBuildingApartment(P.p3);
  const p3owner = await seedOwnerWithOwnership(p3apt);
  const p3ProjDoc = await seedProjectDoc(P.p3);
  await seedSig(p3ProjDoc, p3owner, 'signed');
  await seedSig(p3ProjDoc, p3owner, 'signed');
  await seedSig(p3ProjDoc, p3owner, 'pending');

  // ----- Cross-project owner: an owner in BOTH P1 and P3 must be counted ONCE
  // for the agent (DISTINCT) and still counted (present in assigned P1).
  const sharedApt1 = await seedBuildingApartment(P.p1);
  const sharedNid = String(nidCounter++);
  const sharedOwnerId = await withTenant(org.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as never, {
      name: 'בעלים משותף',
      nationalId: sharedNid,
      phone: '0509999999',
    });
    const [own] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
      })
      .returning({ id: owners.id });
    return own!.id;
  });
  const sharedApt3 = await seedBuildingApartment(P.p3);
  await withTenant(org.id, async (tx) => {
    // Each apartment is solely owned by the shared owner (100% each) so the
    // per-apartment sum-to-100 trigger is satisfied; the owner spans P1 + P3.
    await tx.insert(ownerships).values([
      { apartmentId: sharedApt1, ownerId: sharedOwnerId, ownershipPct: '100', role: 'owner' },
      { apartmentId: sharedApt3, ownerId: sharedOwnerId, ownershipPct: '100', role: 'owner' },
    ]);
  });

  // ----- 0.1 SINGLE-SOURCE POISON: an ARCHIVED project doc on P1 carrying a signed
  // + a pending sig. The OLD manager/viewer KPI used a bare `COUNT(*) FROM
  // signature_requests WHERE status=…` that COUNTED these (archived-inclusive,
  // doc-scope-blind), so the home KPI did not reconcile to the per-project boards
  // (which exclude archived docs via projectSetSignatureDocIdsSql). The fixed KPI
  // MUST exclude them — leaving the org-wide tallies below UNCHANGED (6 signed / 4
  // pending), while the raw bare count is strictly higher (asserted in OS-11/OS-12).
  const p1ArchivedDoc = await seedProjectDoc(P.p1, true);
  await seedSig(p1ArchivedDoc, p1ownerA, 'signed');
  await seedSig(p1ArchivedDoc, p1ownerB, 'pending');

  // ----- Compute expected tallies (single source of truth).
  // Agent residents = distinct owners reachable via P1+P2 apartments:
  //   P1: p1ownerA, p1ownerB, sharedOwner (via sharedApt1)  → 3
  //   P2: p2owner                                           → 1
  //   shared counted ONCE even though also in P3.            => 4
  expected.agent.residents = 4;
  // Agent signaturesReceived (signed) on P1+P2 docs:
  //   P1 proj: 2, P1 apt: 1, P2 apt: 1                       => 4
  expected.agent.signaturesReceived = 4;
  // Agent signaturesPending on P1+P2 docs:
  //   P1 proj: 1, P1 apt: 1, P2 apt: 1                       => 3
  expected.agent.signaturesPending = 3;

  // Manager (ORG-WIDE) residents = all distinct active owners:
  //   p1ownerA, p1ownerB, p2owner, p3owner, sharedOwner      => 5
  expected.manager.residents = 5;
  // Manager signed (org-wide): agent's 4 + P3's 2            => 6
  expected.manager.signaturesReceived = 6;
  // Manager pending (org-wide): agent's 3 + P3's 1           => 4
  expected.manager.signaturesPending = 4;
}, 180_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('orgStats — AGENT is scoped to assigned projects', () => {
  it('OS-1) agent.activeProjects === 2 (assigned P1+P2, NOT P3)', async () => {
    const s = await svc.orgStats(agent());
    expect(s.activeProjects).toBe(expected.agent.activeProjects);
  });

  it('OS-2) agent.residents === distinct owners in P1+P2 only (shared owner counted once)', async () => {
    const s = await svc.orgStats(agent());
    expect(s.residents).toBe(expected.agent.residents);
  });

  it('OS-3) agent.signaturesReceived === signed on P1+P2 docs only (apt docs included, cancelled excluded)', async () => {
    const s = await svc.orgStats(agent());
    expect(s.signaturesReceived).toBe(expected.agent.signaturesReceived);
  });

  it('OS-4) agent.signaturesPending === pending on P1+P2 docs only (cancelled excluded)', async () => {
    const s = await svc.orgStats(agent());
    expect(s.signaturesPending).toBe(expected.agent.signaturesPending);
  });

  it('OS-5) agent counts are STRICTLY LESS than org-wide (no P3 leak)', async () => {
    const a = await svc.orgStats(agent());
    const m = await svc.orgStats(manager());
    expect(a.activeProjects).toBeLessThan(m.activeProjects);
    expect(a.residents).toBeLessThan(m.residents);
    expect(a.signaturesReceived).toBeLessThan(m.signaturesReceived);
    expect(a.signaturesPending).toBeLessThan(m.signaturesPending);
  });
});

describe('orgStats — MANAGER stays ORG-WIDE (only agents are scoped)', () => {
  it('OS-6) manager.activeProjects === 3 (all projects)', async () => {
    const s = await svc.orgStats(manager());
    expect(s.activeProjects).toBe(expected.manager.activeProjects);
  });

  it('OS-7) manager.residents === all distinct active owners', async () => {
    const s = await svc.orgStats(manager());
    expect(s.residents).toBe(expected.manager.residents);
  });

  it('OS-8) manager signatures are org-wide (signed + pending, cancelled excluded)', async () => {
    const s = await svc.orgStats(manager());
    expect(s.signaturesReceived).toBe(expected.manager.signaturesReceived);
    expect(s.signaturesPending).toBe(expected.manager.signaturesPending);
  });

  // 0.1 SINGLE-SOURCE — the manager KPI is DOC-SCOPED + archived-excluded, the same
  // definition the per-project boards/pulse use, so the home numbers reconcile to the
  // boards. The raw un-scoped count (the OLD bug) is strictly higher because it counts
  // the archived-doc poison. These FAIL on the pre-fix bare-COUNT(*) code.
  it('OS-11) manager.signaturesReceived EXCLUDES archived-doc signed sigs (raw bare count is higher)', async () => {
    const s = await svc.orgStats(manager());
    const raw = await withTenant(org.id, (tx) =>
      tx.execute(sql`SELECT COUNT(*)::int AS c FROM signature_requests WHERE status = 'signed'`),
    );
    const rawSigned = Number((raw as unknown as { rows: Array<{ c: number }> }).rows[0]!.c);
    expect(rawSigned).toBeGreaterThan(s.signaturesReceived); // archived poison is in raw, NOT the KPI
    expect(s.signaturesReceived).toBe(expected.manager.signaturesReceived); // still the doc-scoped 6
  });

  it('OS-12) manager.signaturesPending EXCLUDES archived-doc pending sigs (raw bare count is higher)', async () => {
    const s = await svc.orgStats(manager());
    const raw = await withTenant(org.id, (tx) =>
      tx.execute(sql`SELECT COUNT(*)::int AS c FROM signature_requests WHERE status = 'pending'`),
    );
    const rawPending = Number((raw as unknown as { rows: Array<{ c: number }> }).rows[0]!.c);
    expect(rawPending).toBeGreaterThan(s.signaturesPending);
    expect(s.signaturesPending).toBe(expected.manager.signaturesPending);
  });
});

describe('orgStats — agent with ZERO assignments sees nothing', () => {
  it('OS-9) all four counts === 0', async () => {
    const s = await svc.orgStats(agentZero());
    expect(s).toEqual({
      activeProjects: 0,
      residents: 0,
      signaturesReceived: 0,
      signaturesPending: 0,
    });
  });
});

describe('orgStats — UNASSIGNED (unassigned_at set) does NOT grant scope', () => {
  it('OS-10) unassigning the agent from P2 drops P2 owners + sigs from the counts', async () => {
    // Snapshot before unassigning.
    const before = await svc.orgStats(agent());
    expect(before.activeProjects).toBe(2);

    // Unassign from P2 (set unassigned_at). The agent keeps only P1.
    await db.execute(sql`
      UPDATE project_assignments SET unassigned_at = now()
      WHERE user_id = ${agentId} AND project_id = ${P.p2} AND unassigned_at IS NULL
    `);

    const after = await svc.orgStats(agent());
    // Now only P1 is in scope.
    expect(after.activeProjects).toBe(1);
    // P1-only residents: p1ownerA, p1ownerB, sharedOwner = 3 (P2's owner dropped).
    expect(after.residents).toBe(3);
    // P1-only signed: proj 2 + apt 1 = 3 (P2 apt's 1 signed dropped).
    expect(after.signaturesReceived).toBe(3);
    // P1-only pending: proj 1 + apt 1 = 2 (P2 apt's 1 pending dropped).
    expect(after.signaturesPending).toBe(2);
  });
});
