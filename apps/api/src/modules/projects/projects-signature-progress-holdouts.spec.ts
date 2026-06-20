/**
 * E2 Wave-2 B4 — apartment HOLDOUTS ("מי תקוע / who's stuck") — INDEPENDENT
 * real-DB acceptance spec. Mirrors the proven signature-progress-apartments
 * seeding harness, adds the PII-reveal dimensions (view_owner_pii capability +
 * audit + no national_id/phone egress).
 *
 * THE ENDPOINT (read, NAMED PII):
 *   GET /api/v1/projects/:id/signature-progress/apartments/:apartmentId/holdouts
 *   → { data: { holdouts: [ { ownerId, name, apartmentNumber } ] } }
 *
 * "Holdout" = an ACTIVE owner ownership (ended_at IS NULL AND relationship='owner')
 * of the apartment who DOES NOT hold a SIGNED signature_request on a project
 * document (the EXACT negation of the consent join the drill-down/board use).
 *
 * GATING (mirrors owners reveal-pii):
 *   - view_owner_pii REQUIRED (manager always · agent iff the flag · viewer never).
 *     An agent WITH view_owners but WITHOUT view_owner_pii → 403.
 *   - cross-org / unassigned-agent → no-oracle 404 (assertProjectVisible).
 *   - apartment of another project → no-oracle 404.
 *   - a per-access audit row (apartment.holdouts_revealed) is written.
 *
 * NO EXTRA PII: the response carries ONLY ownerId + name + apartmentNumber.
 * national_id / phone NEVER appear (asserted by scanning the serialised body
 * for seeded secret values).
 *
 * Driven service-level (the dominant in-repo pattern) via `callHoldouts`.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLog,
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
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

/** One holdout row (the 3 fields, NO national_id/phone). */
interface HoldoutRow {
  ownerId: string;
  name: string | null;
  apartmentNumber: string;
}

async function callHoldouts(
  svc: ProjectsService,
  user: AccessTokenPayload,
  projectId: string,
  apartmentId: string,
): Promise<HoldoutRow[]> {
  return svc.signatureProgressHoldouts(user, projectId, apartmentId);
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

let nidCounter = 400000001;
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

/** Owner with REAL encrypted PII so the no-PII assertion is meaningful. */
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

/** N co-owners EQUAL fractions in ONE tx (deferred sum-trigger fires once at COMMIT). */
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
        'jti-hold-' + randomUUID(),
        status,
        new Date(Date.now() + SEVEN_DAYS_MS),
        managerId,
      ],
    );
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

/** Assign agent to a project (active assignment). */
async function assignAgent(agentUserId: string, projectId: string): Promise<void> {
  await db
    .insert(projectAssignments)
    .values({ userId: agentUserId, projectId, assignedBy: managerId });
}

/** Flip the agent's view_owners / view_owner_pii capabilities. */
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
  const tag = `holdouts-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  agentId = await seedAgentUser();
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// #1 — correctness: fully-signed apt → empty; partial apt → only non-signers
// ───────────────────────────────────────────────────────────────────────────
describe('holdouts — correctness', () => {
  it('fully-signed apartment → [] ; partially-signed apartment → only the non-signers', async () => {
    const projectId = org.projects[0]!.id;
    const building = await seedBuilding(projectId);
    const doc = await seedProjectDoc(org.id, projectId);

    // FULL apt — 2 owners, BOTH signed → no holdouts.
    const fullApt = await seedApartment(building, 'FULL-1');
    const fOwner1 = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'חתום-אחד',
      phone: '0540000011',
    });
    const fOwner2 = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'חתום-שתיים',
      phone: '0540000012',
    });
    await seedEqualOwnerships(fullApt, [fOwner1, fOwner2]);
    await seedRequest(org.id, doc, fOwner1, 'signed');
    await seedRequest(org.id, doc, fOwner2, 'signed');

    const fullRows = await callHoldouts(svc, manager(), projectId, fullApt);
    expect(fullRows).toEqual([]);

    // PARTIAL apt — 3 owners: one signed, one pending, one no-request →
    // holdouts = the two non-signers (pending + no-request), NOT the signer.
    const partialApt = await seedApartment(building, 'PART-1');
    const signer = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'החתום',
      phone: '0540000021',
    });
    const pendingOwner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'הממתין',
      phone: '0540000022',
    });
    const noReqOwner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'ללא-בקשה',
      phone: '0540000023',
    });
    await seedEqualOwnerships(partialApt, [signer, pendingOwner, noReqOwner]);
    await seedRequest(org.id, doc, signer, 'signed');
    await seedRequest(org.id, doc, pendingOwner, 'pending');
    // noReqOwner has NO signature_request at all.

    const partialRows = await callHoldouts(svc, manager(), projectId, partialApt);
    const ids = partialRows.map((r) => r.ownerId).sort();
    expect(ids).toEqual([pendingOwner, noReqOwner].sort());
    // the signer is NEVER a holdout
    expect(ids).not.toContain(signer);
    // apartmentNumber stamped on every row
    expect(partialRows.every((r) => r.apartmentNumber === 'PART-1')).toBe(true);
    // names are surfaced (this is the named-list surface)
    expect(partialRows.map((r) => r.name).sort()).toEqual(['הממתין', 'ללא-בקשה'].sort());
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #2 — view_owner_pii denial → 403 (mirrors owners reveal-pii)
// ───────────────────────────────────────────────────────────────────────────
describe('holdouts — view_owner_pii gate', () => {
  it('agent WITH view_owners but WITHOUT view_owner_pii → 403', async () => {
    const projectId = org.projects[1]!.id;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'GATE-1');
    const owner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'תקוע',
      phone: '0540000031',
    });
    await seedOwnership(apt, owner);

    await assignAgent(agentId, projectId);
    await setCaps(agentId, /* view_owners */ true, /* view_owner_pii */ false);

    await expect(callHoldouts(svc, agentFor(agentId), projectId, apt)).rejects.toMatchObject({
      response: { error: { code: 'forbidden' } },
    });

    // and WITH view_owner_pii the same agent is allowed (proves the gate is the
    // capability, not the assignment).
    await setCaps(agentId, true, true);
    const rows = await callHoldouts(svc, agentFor(agentId), projectId, apt);
    expect(rows.map((r) => r.ownerId)).toEqual([owner]);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #3 — no-oracle scoping: cross-org 404 · apartment-not-in-project 404
// ───────────────────────────────────────────────────────────────────────────
describe('holdouts — no-oracle scoping', () => {
  it('a project in ANOTHER org → 404 (no oracle)', async () => {
    const otherTag = `holdouts-other-${Date.now()}`;
    const otherOrg = await createTestOrg(otherTag, otherTag);
    const otherProjectId = otherOrg.projects[0]!.id;
    const anyApartment = randomUUID();

    await expect(callHoldouts(svc, manager(), otherProjectId, anyApartment)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);

  it('an apartment that belongs to a DIFFERENT project → 404 (no oracle)', async () => {
    const projectId = org.projects[0]!.id;
    const otherProjectId = org.projects[1]!.id;
    const otherBuilding = await seedBuilding(otherProjectId);
    const aptInOther = await seedApartment(otherBuilding, 'OTHER-1');

    // visible project, but the apartment is in a different project → 404.
    await expect(callHoldouts(svc, manager(), projectId, aptInOther)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 60_000);

  it('an AGENT NOT assigned to the project → 404 (before any pii compute)', async () => {
    const projectId = org.projects[0]!.id;
    const unassignedAgent = await seedAgentUser(); // no project_assignments row
    await setCaps(unassignedAgent, true, true); // even fully-capable → still 404 (scope first)

    await expect(
      callHoldouts(svc, agentFor(unassignedAgent), projectId, randomUUID()),
    ).rejects.toMatchObject({ response: { error: { code: 'not_found' } } });
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// #4 — audit row written + NO national_id/phone in the response
// ───────────────────────────────────────────────────────────────────────────
describe('holdouts — audit + no extra PII egress', () => {
  it('writes apartment.holdouts_revealed audit AND leaks no national_id/phone', async () => {
    const projectId = org.projects[0]!.id;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'AUDIT-1');

    const secretNatId = natId();
    const secretPhone = '0549991234';
    const secretName = 'ייחודי-תקוע-סודי';
    const owner = await seedOwner(org.id, {
      nationalId: secretNatId,
      name: secretName,
      phone: secretPhone,
    });
    await seedOwnership(apt, owner);
    // no signed request → this owner is a holdout

    const rows = await callHoldouts(svc, manager(), projectId, apt);
    expect(rows.map((r) => r.ownerId)).toEqual([owner]);

    // The NAME is surfaced (named list); national_id + phone NEVER appear.
    const serialised = JSON.stringify(rows);
    expect(serialised).toContain(secretName); // name IS surfaced (the point of B4)
    expect(serialised).not.toContain(secretNatId); // national_id absent
    expect(serialised).not.toContain(secretPhone); // phone absent

    // Field set is EXACTLY the 3 contract fields (no national_id/phone keys).
    expect(Object.keys(rows[0]!).sort()).toEqual(['apartmentNumber', 'name', 'ownerId'].sort());

    // Audit row written for this apartment reveal (WHO/WHICH/WHEN — no values).
    const [audit] = await db
      .select({ action: auditLog.action, afterState: auditLog.afterState })
      .from(auditLog)
      .where(and(eq(auditLog.targetId, apt), eq(auditLog.action, 'apartment.holdouts_revealed')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit, 'no apartment.holdouts_revealed audit row').toBeTruthy();
    // the audit afterState carries only counts/ids — never PII.
    const after = JSON.stringify(audit!.afterState ?? {});
    expect(after).not.toContain(secretNatId);
    expect(after).not.toContain(secretPhone);
    expect(after).not.toContain(secretName);
  }, 60_000);
});
