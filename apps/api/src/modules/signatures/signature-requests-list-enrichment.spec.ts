/**
 * SLICE-2 — signature-requests `list()` ENRICHMENT + projectId filter, an
 * INDEPENDENT real-DB acceptance spec (the test author does NOT touch the impl).
 *
 * THE CHANGE UNDER TEST (security-sensitive — PII + scoping):
 *   GET /api/v1/signature-requests now returns enriched `SignatureRequestListItem`
 *   rows carrying DISPLAY context (projectName / apartmentLabel / documentName)
 *   and `ownerDisplay`, the owner NAME — MASKED-BY-DEFAULT, revealed ONLY behind
 *   `view_owner_pii` (the EXACT B4 holdouts / leverage gate via
 *   `resolveOwnerPiiFidelity`). It also accepts an optional `projectId` filter
 *   that HONORS the existing agent record-scoping.
 *
 * THE INVARIANTS THIS SPEC PINS:
 *   1. ENRICHMENT PRESENT — a manager's row shows projectName/apartmentLabel/
 *      documentName + the real ownerDisplay name (apartment-scoped AND
 *      project-scoped documents both resolve a projectName).
 *   2. MASKED-DEFAULT (default-closed) — a VIEWER gets ownerDisplay=null; a
 *      PII-LESS AGENT (view_owners true, view_owner_pii FALSE) gets
 *      ownerDisplay=null; only a PII-CAPABLE actor (manager, or agent WITH
 *      view_owner_pii) gets the cleartext name. national_id / phone NEVER appear
 *      in the serialised body for ANY role.
 *   3. projectId FILTER honors agent scope — an agent assigned to project A,
 *      filtering by project A, sees A's request; the SAME agent filtering by an
 *      UNASSIGNED project B gets an EMPTY page (never B's request), even though a
 *      request exists there.
 *   4. CURSOR not regressed — with the added joins, keyset pagination still walks
 *      every row exactly once across pages (no row dropped, no duplicate),
 *      including rows that share a created_at millisecond (the D.58 ms-vs-micros
 *      trap).
 *
 * Seeding mirrors signature-requests-correctness.spec.ts +
 * projects-signature-progress-holdouts.spec.ts (buildings → apartments → owners →
 * ownerships → documents → signature_requests). Ground-truth writes go through
 * providerPool (BYPASSRLS). The service is driven directly (the dominant pattern).
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;

const tokenStub = {
  sign: () => ({
    token: `eyJ.LIST-ENRICH.${randomUUID()}`,
    jti: `jti-list-${randomUUID()}`,
    expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
  }),
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
    sid: '00000000-0000-4000-8000-0000000000d1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function managerFor(orgId: string, userId: string): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000d4',
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function viewer(): AccessTokenPayload {
  return {
    sub: managerId, // identity irrelevant for a viewer's masked fidelity
    orgId: org.id,
    role: 'viewer',
    sid: '00000000-0000-4000-8000-0000000000d2',
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agentFor(id: string): AccessTokenPayload {
  return {
    sub: id,
    orgId: org.id,
    role: 'agent',
    sid: '00000000-0000-4000-8000-0000000000d3',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

let nidCounter = 700000001;
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

/** Finalised document. Exactly one of projectId / apartmentId (or neither). */
async function seedDoc(
  orgId: string,
  name: string,
  scope: { projectId?: string; apartmentId?: string },
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, apartment_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, 'contract', 'application/pdf', 100, $5, 'h', $6, now())
       RETURNING id`,
      [
        orgId,
        scope.projectId ?? null,
        scope.apartmentId ?? null,
        name,
        `org/${orgId}/doc/${randomUUID()}`,
        managerId,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Pre-insert a pending signature_request (bypassing the service) for the
 *  default test org's manager. created_at defaults to now(). */
async function seedRequest(orgId: string, documentId: string, ownerId: string): Promise<string> {
  return seedRequestFor(orgId, managerId, documentId, ownerId);
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
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `sig-list-enrich-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// 1 — ENRICHMENT PRESENT (manager): display context + real owner name
// ───────────────────────────────────────────────────────────────────────────
describe('list enrichment — display context (manager)', () => {
  it('apartment-scoped doc → projectName (via apartment→building→project) + apartmentLabel + documentName + owner name', async () => {
    const projectId = org.projects[0]!.id;
    const projectName = org.projects[0]!.name;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'ENR-APT-7');
    const owner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'בעל-דירה-מועשר',
      phone: '0541110001',
    });
    await seedOwnership(apt, owner);
    const doc = await seedDoc(org.id, 'הסכם-דירה-7.pdf', { apartmentId: apt });
    const reqId = await seedRequest(org.id, doc, owner);

    const page = await svc.list(manager(), { limit: 100 });
    const row = page.data.find((r) => r.id === reqId);
    expect(row, 'seeded request must be in the page').toBeTruthy();
    expect(row!.projectName).toBe(projectName);
    expect(row!.apartmentLabel).toBe('ENR-APT-7');
    expect(row!.documentName).toBe('הסכם-דירה-7.pdf');
    expect(row!.ownerDisplay).toBe('בעל-דירה-מועשר');
  }, 60_000);

  it('project-scoped doc → projectName (direct) + apartmentLabel null + documentName + owner name', async () => {
    const projectId = org.projects[1]!.id;
    const projectName = org.projects[1]!.name;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'ENR-APT-PROJ');
    const owner = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'בעל-פרויקט',
      phone: '0541110002',
    });
    await seedOwnership(apt, owner);
    const doc = await seedDoc(org.id, 'הסכם-פרויקט.pdf', { projectId });
    const reqId = await seedRequest(org.id, doc, owner);

    const page = await svc.list(manager(), { limit: 100, projectId });
    const row = page.data.find((r) => r.id === reqId);
    expect(row).toBeTruthy();
    expect(row!.projectName).toBe(projectName);
    expect(row!.apartmentLabel).toBeNull(); // project-scoped doc has no apartment
    expect(row!.documentName).toBe('הסכם-פרויקט.pdf');
    expect(row!.ownerDisplay).toBe('בעל-פרויקט');
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 2 — MASKED-DEFAULT (default-closed) per role + no national_id/phone egress
// ───────────────────────────────────────────────────────────────────────────
describe('list enrichment — owner name masked by default', () => {
  it('VIEWER → ownerDisplay null; PII-less AGENT → null; manager + PII-capable agent → real name; national_id/phone NEVER leak', async () => {
    const projectId = org.projects[0]!.id;
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building, 'MASK-APT');
    const secretNatId = natId();
    const secretPhone = '0549998877';
    const secretName = 'שם-סודי-ממוסך-ייחודי';
    const owner = await seedOwner(org.id, {
      nationalId: secretNatId,
      name: secretName,
      phone: secretPhone,
    });
    await seedOwnership(apt, owner);
    const doc = await seedDoc(org.id, 'mask-doc.pdf', { apartmentId: apt });
    const reqId = await seedRequest(org.id, doc, owner);

    // VIEWER — masked-default: name is null.
    const vPage = await svc.list(viewer(), { limit: 100 });
    const vRow = vPage.data.find((r) => r.id === reqId);
    expect(vRow, 'viewer sees the row (non-PII context)').toBeTruthy();
    expect(vRow!.ownerDisplay).toBeNull();
    // Non-PII context still surfaces for the viewer.
    expect(vRow!.documentName).toBe('mask-doc.pdf');
    expect(vRow!.apartmentLabel).toBe('MASK-APT');
    // The cleartext name (PII) is NOT in the viewer's body, nor national_id/phone.
    const vSer = JSON.stringify(vRow);
    expect(vSer).not.toContain(secretName);
    expect(vSer).not.toContain(secretNatId);
    expect(vSer).not.toContain(secretPhone);

    // PII-LESS AGENT (assigned + view_owners, but view_owner_pii FALSE) → masked.
    const agentId = await seedAgentUser();
    await assignAgent(agentId, projectId);
    await setCaps(agentId, /* view_owners */ true, /* view_owner_pii */ false);
    const aPage = await svc.list(agentFor(agentId), { limit: 100 });
    const aRow = aPage.data.find((r) => r.id === reqId);
    expect(aRow, 'assigned agent sees the row').toBeTruthy();
    expect(aRow!.ownerDisplay).toBeNull(); // default-closed
    expect(JSON.stringify(aRow)).not.toContain(secretName);

    // MANAGER → real name.
    const mPage = await svc.list(manager(), { limit: 100 });
    expect(mPage.data.find((r) => r.id === reqId)!.ownerDisplay).toBe(secretName);

    // PII-CAPABLE AGENT (flip view_owner_pii true) → real name (proves the gate
    // is the capability, not the role/assignment).
    await setCaps(agentId, true, true);
    const aPage2 = await svc.list(agentFor(agentId), { limit: 100 });
    expect(aPage2.data.find((r) => r.id === reqId)!.ownerDisplay).toBe(secretName);

    // Even for the PII-capable views, national_id/phone are NEVER present.
    expect(JSON.stringify(mPage.data)).not.toContain(secretNatId);
    expect(JSON.stringify(mPage.data)).not.toContain(secretPhone);
    expect(JSON.stringify(aPage2.data)).not.toContain(secretNatId);
    expect(JSON.stringify(aPage2.data)).not.toContain(secretPhone);
  }, 90_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 3 — projectId FILTER honors agent record-scoping
// ───────────────────────────────────────────────────────────────────────────
describe('list projectId filter — honors agent scope', () => {
  it('agent assigned to A: filter A → sees A request; filter UNASSIGNED B → empty (never B request)', async () => {
    const projectA = org.projects[0]!.id;
    const projectB = org.projects[1]!.id;

    // A request in project A.
    const bldA = await seedBuilding(projectA);
    const aptA = await seedApartment(bldA, 'SCOPE-A');
    const ownerA = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'בעל-A',
      phone: '0541110011',
    });
    await seedOwnership(aptA, ownerA);
    const docA = await seedDoc(org.id, 'scope-a.pdf', { apartmentId: aptA });
    const reqA = await seedRequest(org.id, docA, ownerA);

    // A request in project B.
    const bldB = await seedBuilding(projectB);
    const aptB = await seedApartment(bldB, 'SCOPE-B');
    const ownerB = await seedOwner(org.id, {
      nationalId: natId(),
      name: 'בעל-B',
      phone: '0541110012',
    });
    await seedOwnership(aptB, ownerB);
    const docB = await seedDoc(org.id, 'scope-b.pdf', { apartmentId: aptB });
    const reqB = await seedRequest(org.id, docB, ownerB);

    // Agent assigned to A ONLY.
    const agentId = await seedAgentUser();
    await assignAgent(agentId, projectA);
    await setCaps(agentId, true, true);

    // filter by A → the A request is present.
    const pageA = await svc.list(agentFor(agentId), { limit: 100, projectId: projectA });
    expect(pageA.data.map((r) => r.id)).toContain(reqA);
    expect(pageA.data.map((r) => r.id)).not.toContain(reqB);

    // filter by the UNASSIGNED project B → EMPTY (the filter cannot widen scope;
    // an agent must never see an unassigned project's requests via projectId).
    const pageB = await svc.list(agentFor(agentId), { limit: 100, projectId: projectB });
    expect(pageB.data.map((r) => r.id)).not.toContain(reqB);
    expect(pageB.data.map((r) => r.id)).not.toContain(reqA);

    // Sanity: a manager filtering by B DOES see the B request (proves B exists
    // and the empty agent page is a scope decision, not a missing row).
    const mgrB = await svc.list(manager(), { limit: 100, projectId: projectB });
    expect(mgrB.data.map((r) => r.id)).toContain(reqB);
  }, 90_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 4 — CURSOR not regressed by the added joins (incl. same-millisecond rows)
// ───────────────────────────────────────────────────────────────────────────
describe('list cursor — enrichment does not regress keyset pagination', () => {
  it('walks every row exactly once across pages, including rows sharing a created_at millisecond', async () => {
    // A FRESH hermetic org so the page is exactly our seeded rows (no sibling
    // pollution) and the walk assertion is exact.
    const tag = `sig-list-cursor-${Date.now()}`;
    const freshOrg = await createTestOrg(tag, tag);
    const freshMgr = freshOrg.users[0]!.id;
    const projectId = freshOrg.projects[0]!.id;

    const sharedMs = '2026-06-23T10:00:00.123456+00:00'; // micros differ via row order
    const ids: string[] = [];
    // 6 requests: two pinned to the SAME millisecond (the D.58 trap), the rest
    // spread, each its own owner (1 owner per apartment = 100% sum).
    for (let i = 0; i < 6; i++) {
      const bld = await seedBuilding(projectId);
      const a = await seedApartment(bld, `CUR-${i}`);
      const o = await seedOwner(freshOrg.id, {
        nationalId: natId(),
        name: `cur-owner-${i}`,
        phone: `05400000${10 + i}`,
      });
      await seedOwnership(a, o);
      const d = await seedDoc(freshOrg.id, `cur-${i}.pdf`, { apartmentId: a });
      // rows 2 and 3 share the SAME created_at millisecond.
      const createdAt = i === 2 || i === 3 ? sharedMs : undefined;
      ids.push(await seedRequestFor(freshOrg.id, freshMgr, d, o, { createdAt }));
    }

    // Walk in pages of 2; collect every id; assert no drop, no dup, full set.
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: {
        data: Array<{ id: string }>;
        page: { cursor: string | null; has_more: boolean };
      } = await svc.list(managerFor(freshOrg.id, freshMgr), {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.data.map((r) => r.id));
      cursor = page.page.cursor;
      guard += 1;
    } while (cursor && guard < 20);

    // Every seeded row appears EXACTLY once (no same-ms drop, no duplicate).
    for (const id of ids) {
      expect(seen.filter((s) => s === id).length, `row ${id} seen exactly once`).toBe(1);
    }
    // No extra rows (hermetic org).
    expect(seen.sort()).toEqual([...ids].sort());
  }, 120_000);
});

/** Variant of seedRequest bound to a specific org's manager (for the hermetic
 *  cursor org). created_at can be pinned to force a same-millisecond pair. */
async function seedRequestFor(
  orgId: string,
  createdBy: string,
  documentId: string,
  ownerId: string,
  opts: { createdAt?: string } = {},
): Promise<string> {
  const c = await providerPool.connect();
  try {
    if (opts.createdAt) {
      const r = await c.query<{ id: string }>(
        `INSERT INTO signature_requests
           (org_id, document_id, owner_id, jti, status, expires_at, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::timestamptz)
         RETURNING id`,
        [
          orgId,
          documentId,
          ownerId,
          'jti-cur-' + randomUUID(),
          new Date(Date.now() + SEVEN_DAYS_MS),
          createdBy,
          opts.createdAt,
        ],
      );
      return r.rows[0]!.id;
    }
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests
         (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id`,
      [
        orgId,
        documentId,
        ownerId,
        'jti-cur-' + randomUUID(),
        new Date(Date.now() + SEVEN_DAYS_MS),
        createdBy,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}
