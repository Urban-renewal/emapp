/**
 * Battle-Map BM-1 — the LEVERAGE scorer — INDEPENDENT real-DB acceptance spec.
 * Mirrors the proven signature-progress / holdouts seeding harness.
 *
 * THE ENDPOINT (read; ownerName is NAMED PII, view_owner_pii-gated):
 *   GET /api/v1/projects/:id/leverage
 *   → { data: { projectId, currentPct, basis:'share',
 *               leverage: { ownerId, ownerName|null, apartmentId, apartmentLabel,
 *                           ownerSharePctInApartment, projectedPct,
 *                           crossesThreshold } | null } }
 *
 * THE CRITICAL CORRECTNESS RULE (council + red-team): the headline consentedPct
 * is an EQUAL-APARTMENT-WEIGHTED average of per-apartment share contributions
 * (computeConsentAggregates). Signing an owner flips them in EVERY apartment they
 * own, so the leverage owner is the one with the max positive MARGINAL DELTA to
 * the headline (summed over their apartments) — NOT the largest raw share. The #1
 * test constructs a project where the largest single-share unsigned owner
 * (share-sum would pick them) has a SMALLER summed headline delta than an owner
 * spread across two half-signed apartments, and asserts the scorer picks the
 * spread owner.
 *
 * Driven service-level (the dominant in-repo pattern) via `callLeverage`.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLog,
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  projects,
  users,
  withTenant,
} from '@emapp/db';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function callLeverage(svc: ProjectsService, user: AccessTokenPayload, projectId: string) {
  return svc.leverage(user, projectId);
}

let svc: ProjectsService;
let org: TestOrg;
let managerId: string;
let agentId: string;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000f1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function agentFor(id: string): AccessTokenPayload {
  return {
    sub: id,
    orgId: org.id,
    role: 'agent',
    sid: '00000000-0000-4000-8000-0000000000f2',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function viewer(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'viewer',
    sid: '00000000-0000-4000-8000-0000000000f3',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

let nidCounter = 700000001;
function natId(): string {
  return String(nidCounter++);
}

/** A fresh project in the test org (factory only seeds 2; tests want isolation). */
async function seedProject(): Promise<string> {
  return withTenant(org.id, async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({
        orgId: org.id,
        name: `lev-${randomUUID()}`,
        type: 'tama38_1',
        createdBy: managerId,
      })
      .returning({ id: projects.id });
    return p!.id;
  });
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

async function seedApartment(buildingId: string, number: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [buildingId, number],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

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

/**
 * Insert ALL of an apartment's owner shares in ONE transaction, so the
 * DEFERRABLE INITIALLY DEFERRED sum-check trigger fires ONCE at COMMIT (the
 * shares must sum to exactly 1 over the apartment's active owner rows — migration
 * 0065). Inserting owners one-per-tx would trip the check on the first partial row.
 */
async function seedShares(
  apartmentId: string,
  shares: Array<{ ownerId: string; num: number; den: number }>,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    for (const { ownerId, num, den } of shares) {
      await c.query(
        `INSERT INTO ownerships
           (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
         VALUES ($1, $2, $3, 'owner', $4, $5)`,
        [apartmentId, ownerId, ((num / den) * 100).toFixed(2), num, den],
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

/** Sole-owner convenience: one 1/1 ownership in its own tx. */
async function seedShare(apartmentId: string, ownerId: string): Promise<void> {
  await seedShares(apartmentId, [{ ownerId, num: 1, den: 1 }]);
}

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

async function seedRequest(
  orgId: string,
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
        orgId,
        documentId,
        ownerId,
        'jti-lev-' + randomUUID(),
        status,
        new Date(Date.now() + SEVEN_DAYS_MS),
        managerId,
      ],
    );
  } finally {
    c.release();
  }
}

async function setTarget(projectId: string, pct: number): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE projects SET target_signature_pct = $1 WHERE id = $2`, [
      pct.toFixed(2),
      projectId,
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

async function assignAgent(agentUserId: string, projectId: string): Promise<void> {
  await db
    .insert(projectAssignments)
    .values({ userId: agentUserId, projectId, assignedBy: managerId });
}

async function setCaps(
  agentUserId: string,
  viewOwners: boolean,
  viewOwnerPii: boolean,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships
         SET capabilities = jsonb_set(
           jsonb_set(capabilities, '{view_owners}', $1::jsonb),
           '{view_owner_pii}', $2::jsonb)
       WHERE user_id = $3 AND org_id = $4 AND revoked_at IS NULL`,
      [viewOwners ? 'true' : 'false', viewOwnerPii ? 'true' : 'false', agentUserId, org.id],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  const tag = `leverage-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  agentId = await seedAgentUser();
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// #1 — THE CORE: marginal-delta picks the RIGHT owner even when another owner
//      has a strictly LARGER share (share-sum would pick wrong).
// ───────────────────────────────────────────────────────────────────────────
describe('leverage — marginal-delta, NOT share-sum', () => {
  it('picks the spread owner (larger headline delta) over the larger single-share owner', async () => {
    // Every apartment's owner shares sum to exactly 1 (the DB constraint). The
    // divergence comes from the EQUAL-APARTMENT weighting + the fact that signing
    // ONE owner flips them in ALL their apartments:
    //
    //   - BIG  owns 0.9 of apartment P (a 0.1 co-owner is UNSIGNED). Flipping BIG:
    //       P contribution 0 → 0.9  ⇒  total delta 0.9. BIG's per-apartment share
    //       0.9 is the LARGEST single share in the project (share-sum picks BIG).
    //   - SPREAD owns 0.5 of apartment Q1 (other 0.5 already SIGNED) AND 0.5 of
    //       apartment Q2 (other 0.5 already SIGNED). Flipping SPREAD signs them in
    //       BOTH: Q1 0.5→1.0 (Δ0.5) + Q2 0.5→1.0 (Δ0.5)  ⇒  total delta 1.0.
    //
    // SPREAD's largest single share (0.5) is SMALLER than BIG's (0.9), so a naive
    // share-sum / largest-share ranking would pick BIG — but the correct
    // marginal-delta-to-headline is SPREAD (1.0 > 0.9). The scorer MUST pick SPREAD.
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    // Apartment P — BIG (0.9, unsigned) + a 0.1 unsigned co-owner (sum = 1).
    const aptP = await seedApartment(building, 'P');
    const ownerBig = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'מנוף-גדול',
      phone: '0540000111',
    });
    const pTiny = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'זנב-פי',
      phone: '0540000112',
    });
    await seedShares(aptP, [
      { ownerId: ownerBig, num: 9, den: 10 }, // 0.9 (unsigned — the largest single share)
      { ownerId: pTiny, num: 1, den: 10 }, // 0.1 (unsigned)
    ]);

    // SPREAD owns 0.5 of Q1 and 0.5 of Q2; the OTHER half of each is already signed.
    const ownerSpread = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'מנוף-פרוס',
      phone: '0540000113',
    });
    const aptQ1 = await seedApartment(building, 'Q1');
    const q1Signed = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'חתום-קיו1',
      phone: '0540000114',
    });
    await seedShares(aptQ1, [
      { ownerId: ownerSpread, num: 1, den: 2 }, // 0.5 (unsigned)
      { ownerId: q1Signed, num: 1, den: 2 }, // 0.5 (signed below)
    ]);
    await seedRequest(org.id, doc, q1Signed, 'signed');

    const aptQ2 = await seedApartment(building, 'Q2');
    const q2Signed = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'חתום-קיו2',
      phone: '0540000115',
    });
    await seedShares(aptQ2, [
      { ownerId: ownerSpread, num: 1, den: 2 }, // 0.5 (unsigned, SAME owner as Q1)
      { ownerId: q2Signed, num: 1, den: 2 }, // 0.5 (signed below)
    ]);
    await seedRequest(org.id, doc, q2Signed, 'signed');

    const res = await callLeverage(svc, manager(), projectId);

    // The scorer MUST pick SPREAD (summed delta 1.0), NOT BIG (delta 0.9) — even
    // though BIG holds the larger single share. THIS is the marginal-delta rule:
    // signing flips the owner in EVERY apartment, and apartments are equal-weighted.
    expect(res.leverage).not.toBeNull();
    expect(res.leverage!.ownerId).toBe(ownerSpread);
    // Sanity: a naive largest-single-share ranking WOULD have picked BIG (0.9 > 0.5).
    expect(res.leverage!.ownerId).not.toBe(ownerBig);

    // basis label present + share.
    expect(res.basis).toBe('share');
    expect(res.projectId).toBe(projectId);
    // SPREAD's reported apartment is one of their two (Q1 by the tie-break order).
    expect(['Q1', 'Q2']).toContain(res.leverage!.apartmentLabel);
    // SPREAD holds 50% of that apartment's active share.
    expect(res.leverage!.ownerSharePctInApartment).toBeCloseTo(50, 5);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #2 — projectedPct + crossesThreshold are correct.
// ───────────────────────────────────────────────────────────────────────────
describe('leverage — projectedPct + threshold crossing', () => {
  it('projects the headline after the flip and flags threshold crossing', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    // Two apartments, each a single 100% owner. One signed (contribution 1), one
    // unsigned (contribution 0). currentPct = round((1 + 0) / 2 * 100) = 50.
    const aptA = await seedApartment(building, 'A');
    const aptB = await seedApartment(building, 'B');
    const oA = await seedOwner(org.id, { nationalId: natId(), name: 'אלף', phone: '0540000201' });
    const oB = await seedOwner(org.id, { nationalId: natId(), name: 'בית', phone: '0540000202' });
    await seedShare(aptA, oA);
    await seedShare(aptB, oB);
    await seedRequest(org.id, doc, oA, 'signed');
    // oB unsigned → the only leverage candidate. Flipping oB: Δcontrib = 1.0,
    // projected = round((1 + 1) / 2 * 100) = 100.
    await setTarget(projectId, 90);

    const res = await callLeverage(svc, manager(), projectId);
    expect(res.currentPct).toBe(50);
    expect(res.leverage).not.toBeNull();
    expect(res.leverage!.ownerId).toBe(oB);
    expect(res.leverage!.projectedPct).toBe(100);
    // 100 >= target 90 → crosses.
    expect(res.leverage!.crossesThreshold).toBe(true);
  }, 60_000);

  it('crossesThreshold is false when the flip still falls short', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    // Four single-owner apartments, ALL unsigned → currentPct = 0. Flipping the
    // best single owner raises the headline to round(1/4*100) = 25, which is
    // below a 90 target → does NOT cross.
    const owners4: string[] = [];
    for (let i = 0; i < 4; i++) {
      const apt = await seedApartment(building, `Q${i}`);
      const o = await seedOwner(org.id, {
        nationalId: natId(),
        name: `דייר-${i}`,
        phone: `054000030${i}`,
      });
      await seedShare(apt, o);
      owners4.push(o);
    }
    void doc;
    await setTarget(projectId, 90);

    const res = await callLeverage(svc, manager(), projectId);
    expect(res.currentPct).toBe(0);
    expect(res.leverage).not.toBeNull();
    expect(res.leverage!.projectedPct).toBe(25);
    expect(res.leverage!.crossesThreshold).toBe(false);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #3 — null cases: all signed → null ; no movable owner → null.
// ───────────────────────────────────────────────────────────────────────────
describe('leverage — null cases', () => {
  it('every active owner already signed → leverage null', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    const apt = await seedApartment(building, 'DONE-1');
    const o1 = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'גמור-1',
      phone: '0540000401',
    });
    const o2 = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'גמור-2',
      phone: '0540000402',
    });
    await seedShares(apt, [
      { ownerId: o1, num: 1, den: 2 },
      { ownerId: o2, num: 1, den: 2 },
    ]);
    await seedRequest(org.id, doc, o1, 'signed');
    await seedRequest(org.id, doc, o2, 'signed');

    const res = await callLeverage(svc, manager(), projectId);
    expect(res.leverage).toBeNull();
    expect(res.currentPct).toBe(100);
    expect(res.basis).toBe('share');
  }, 60_000);

  it('a project with no apartments/owners → leverage null, currentPct 0', async () => {
    const projectId = await seedProject();
    const res = await callLeverage(svc, manager(), projectId);
    expect(res.leverage).toBeNull();
    expect(res.currentPct).toBe(0);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #4 — view_owner_pii gating: name-or-no-name (NOT a 403); no national_id/phone.
// ───────────────────────────────────────────────────────────────────────────
describe('leverage — view_owner_pii name fidelity', () => {
  it('manager → name present + audit; viewer → leverage WITHOUT name; no PII egress', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);

    const apt = await seedApartment(building, 'PII-1');
    const secretNatId = natId();
    const secretPhone = '0549995678';
    const secretName = 'מנוף-סודי-ייחודי';
    const owner = await seedOwner(org.id, {
      nationalId: secretNatId,
      name: secretName,
      phone: secretPhone,
    });
    await seedShare(apt, owner); // sole owner, unsigned → the leverage owner

    // MANAGER (unmasked) → name surfaced.
    const mRes = await callLeverage(svc, manager(), projectId);
    expect(mRes.leverage).not.toBeNull();
    expect(mRes.leverage!.ownerId).toBe(owner);
    expect(mRes.leverage!.ownerName).toBe(secretName);

    // national_id / phone NEVER appear anywhere in the serialised response.
    const serialised = JSON.stringify(mRes);
    expect(serialised).toContain(secretName); // name IS surfaced for the manager
    expect(serialised).not.toContain(secretNatId);
    expect(serialised).not.toContain(secretPhone);

    // Exactly the 7 leverage fields — no national_id/phone keys.
    expect(Object.keys(mRes.leverage!).sort()).toEqual(
      [
        'apartmentId',
        'apartmentLabel',
        'crossesThreshold',
        'ownerId',
        'ownerName',
        'ownerSharePctInApartment',
        'projectedPct',
      ].sort(),
    );

    // Audit row for the named reveal (WHO/WHICH — no PII values).
    const [audit] = await db
      .select({ action: auditLog.action, afterState: auditLog.afterState })
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, projectId), eq(auditLog.action, 'project.leverage_revealed')),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit, 'no project.leverage_revealed audit row').toBeTruthy();
    const after = JSON.stringify(audit!.afterState ?? {});
    expect(after).not.toContain(secretNatId);
    expect(after).not.toContain(secretPhone);
    expect(after).not.toContain(secretName);

    // VIEWER (masked) → SAME leverage owner, but ownerName null (NOT a 403).
    const vRes = await callLeverage(svc, viewer(), projectId);
    expect(vRes.leverage).not.toBeNull();
    expect(vRes.leverage!.ownerId).toBe(owner);
    expect(vRes.leverage!.ownerName).toBeNull();
    // no name leaks for the viewer either.
    expect(JSON.stringify(vRes)).not.toContain(secretName);
  }, 60_000);

  it('agent WITH view_owners but WITHOUT view_owner_pii → leverage WITHOUT name (not 403)', async () => {
    const projectId = await seedProject();
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'AGENT-1');
    const owner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'מנוף-סוכן',
      phone: '0540000601',
    });
    await seedShare(apt, owner);

    await assignAgent(agentId, projectId);
    await setCaps(agentId, /* view_owners */ true, /* view_owner_pii */ false);

    const res = await callLeverage(svc, agentFor(agentId), projectId);
    expect(res.leverage).not.toBeNull();
    expect(res.leverage!.ownerId).toBe(owner);
    expect(res.leverage!.ownerName).toBeNull();

    // WITH view_owner_pii the SAME agent gets the name.
    await setCaps(agentId, true, true);
    const res2 = await callLeverage(svc, agentFor(agentId), projectId);
    expect(res2.leverage!.ownerName).toBe('מנוף-סוכן');
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #5 — no-oracle scoping: cross-org → 404 ; unassigned agent → 404.
// ───────────────────────────────────────────────────────────────────────────
describe('leverage — no-oracle scoping', () => {
  it('a project in ANOTHER org → 404 (no oracle)', async () => {
    const otherTag = `leverage-other-${Date.now()}`;
    const otherOrg = await createTestOrg(otherTag, otherTag);
    const otherProjectId = otherOrg.projects[0]!.id;

    await expect(callLeverage(svc, manager(), otherProjectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);

  it('an AGENT NOT assigned to the project → 404 (before any compute)', async () => {
    const projectId = await seedProject();
    const unassignedAgent = await seedAgentUser(); // no project_assignments row
    await setCaps(unassignedAgent, true, true);

    await expect(callLeverage(svc, agentFor(unassignedAgent), projectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);
});
