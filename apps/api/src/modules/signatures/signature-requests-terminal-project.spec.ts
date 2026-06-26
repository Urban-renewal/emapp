/**
 * TERMINAL-PROJECT GATE (red-team round-4 LOW) — adversarial, deterministic
 * real-DB spec. A signing link must NOT be issued against a document whose
 * parent PROJECT is terminal (`cancelled` / `completed`, per the canonical
 * `PROJECT_TERMINAL_STATUSES`) or archived — chasing a dead deal.
 *
 * Reuses the canonical `PROJECT_TERMINAL_STATUSES` source (no hardcoded list).
 * The guard rejects the WHOLE create — single AND bulk/campaign — because a
 * document carries exactly one project, so every recipient under it would be
 * chasing the same dead deal.
 *
 * Coverage:
 *   - single create against a `cancelled` project → rejected
 *     `signature_request_project_terminal`, NO row.
 *   - single create against a `completed` project → rejected, NO row.
 *   - single create against an ARCHIVED (non-terminal status) project → rejected.
 *   - HAPPY PATH preserved: `gathering_signatures` AND `approved` (non-terminal)
 *     → create SUCCEEDS, row written.
 *   - BULK create against a `cancelled` project → whole batch rejected, NO rows.
 *   - BULK happy path (`approved`) → created.
 *   - apartment-scoped document resolves the project via apartment→building→
 *     project and is gated the same way (cancelled → rejected).
 *
 * Seeding mirrors signature-requests-correctness.spec.ts (buildings →
 * apartments → owners → ownerships → documents). Project status/archive are
 * driven via providerPool (BYPASSRLS) so we can move a project into any state
 * independent of the create-form transition rules.
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { PROJECT_TERMINAL_STATUSES } from '@emapp/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.TERMINALPROJECTTOKEN';
let mintCount = 0;
const tokenStub = {
  sign: () => {
    mintCount += 1;
    return {
      token: `${FAKE_JWT_PREFIX}.sig-${mintCount}-${randomUUID()}`,
      jti: `jti-terminal-${mintCount}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
    };
  },
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
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function natId(): string {
  return String(Math.floor(100000000 + Math.random() * 899999999));
}

/** Seed a fresh project in a chosen status; returns its id. Driven via
 *  providerPool so we can place it in ANY status (incl. terminal) regardless of
 *  the create-form transition gate. */
async function seedProject(
  orgId: string,
  status: string,
  opts: { archived?: boolean } = {},
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, status, archived_at, created_by)
       VALUES ($1, $2, 'tama38_1', $3, ${opts.archived ? `now()` : `NULL`}, $4)
       RETURNING id`,
      [orgId, `proj-${randomUUID().slice(0, 8)}`, status, managerId],
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

/** Active `owner` ownership at 100% (keeps the D.25 sum trigger satisfied). */
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

/** Seed a FINALISED document. Pass projectId for a project-scoped doc, or
 *  apartmentId for an apartment-scoped doc (exactly one). */
async function seedDoc(
  orgId: string,
  scope: { projectId?: string; apartmentId?: string },
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, apartment_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, 'd.pdf', 'contract', 'application/pdf', 100, $4, 'h', $5, now())
       RETURNING id`,
      [
        orgId,
        scope.projectId ?? null,
        scope.apartmentId ?? null,
        `org/${orgId}/doc/${randomUUID()}`,
        managerId,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function countRequests(documentId: string, ownerId: string): Promise<number> {
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

/** Build a project-scoped finalised doc + an associated owner in `status`. */
async function projectScopedFixture(
  status: string,
  opts: { archived?: boolean } = {},
): Promise<{ doc: string; ownerId: string }> {
  const project = await seedProject(org.id, status, opts);
  const building = await seedBuilding(project);
  const apartment = await seedApartment(building);
  const ownerId = await seedOwner(org.id);
  await seedOwnership(apartment, ownerId);
  const doc = await seedDoc(org.id, { projectId: project });
  return { doc, ownerId };
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `sig-terminal-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// Sanity: the canonical source is exactly the two terminal statuses. If the
// state machine changes, this spec's intent (cancelled+completed) is re-asserted.
describe('canonical PROJECT_TERMINAL_STATUSES', () => {
  it('contains cancelled and completed (and only those today)', () => {
    expect([...PROJECT_TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'completed']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SINGLE create — terminal projects rejected
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — single create', () => {
  it('REJECTS create against a CANCELLED project → signature_request_project_terminal, NO row', async () => {
    const { doc, ownerId } = await projectScopedFixture('cancelled');
    await expect(svc.create(manager(), { documentId: doc, ownerId })).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect(await countRequests(doc, ownerId)).toBe(0);
  }, 30_000);

  it('REJECTS create against a COMPLETED project → signature_request_project_terminal, NO row', async () => {
    const { doc, ownerId } = await projectScopedFixture('completed');
    await expect(svc.create(manager(), { documentId: doc, ownerId })).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect(await countRequests(doc, ownerId)).toBe(0);
  }, 30_000);

  it('REJECTS create against an ARCHIVED (non-terminal status) project → signature_request_project_terminal, NO row', async () => {
    const { doc, ownerId } = await projectScopedFixture('gathering_signatures', { archived: true });
    await expect(svc.create(manager(), { documentId: doc, ownerId })).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect(await countRequests(doc, ownerId)).toBe(0);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// HAPPY PATH preserved — non-terminal projects still succeed
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — happy path (non-terminal) preserved', () => {
  it('ALLOWS create against a GATHERING_SIGNATURES project → request created', async () => {
    const { doc, ownerId } = await projectScopedFixture('gathering_signatures');
    const res = await svc.create(manager(), { documentId: doc, ownerId });
    expect(res.request).toBeDefined();
    expect(res.request.ownerId).toBe(ownerId);
    expect(res.request.status).toBe('pending');
    expect(await countRequests(doc, ownerId)).toBe(1);
  }, 30_000);

  it('ALLOWS create against an APPROVED project → request created', async () => {
    const { doc, ownerId } = await projectScopedFixture('approved');
    const res = await svc.create(manager(), { documentId: doc, ownerId });
    expect(res.request).toBeDefined();
    expect(res.request.ownerId).toBe(ownerId);
    expect(res.request.status).toBe('pending');
    expect(await countRequests(doc, ownerId)).toBe(1);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// APARTMENT-scoped document — project resolved via apt→building→project
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — apartment-scoped document', () => {
  it('REJECTS an apartment-scoped doc whose project is CANCELLED → signature_request_project_terminal, NO row', async () => {
    const project = await seedProject(org.id, 'cancelled');
    const building = await seedBuilding(project);
    const apartment = await seedApartment(building);
    const ownerId = await seedOwner(org.id);
    await seedOwnership(apartment, ownerId);
    const doc = await seedDoc(org.id, { apartmentId: apartment });

    await expect(svc.create(manager(), { documentId: doc, ownerId })).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect(await countRequests(doc, ownerId)).toBe(0);
  }, 30_000);

  it('ALLOWS an apartment-scoped doc whose project is GATHERING_SIGNATURES → request created (control)', async () => {
    const project = await seedProject(org.id, 'gathering_signatures');
    const building = await seedBuilding(project);
    const apartment = await seedApartment(building);
    const ownerId = await seedOwner(org.id);
    await seedOwnership(apartment, ownerId);
    const doc = await seedDoc(org.id, { apartmentId: apartment });

    const res = await svc.create(manager(), { documentId: doc, ownerId });
    expect(res.request).toBeDefined();
    expect(res.request.status).toBe('pending');
    expect(await countRequests(doc, ownerId)).toBe(1);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// BULK / campaign — the whole batch is rejected on a terminal project
// ───────────────────────────────────────────────────────────────────────────

describe('terminal-project gate — bulk create', () => {
  it('REJECTS the WHOLE bulk against a CANCELLED project → signature_request_project_terminal, NO rows', async () => {
    const project = await seedProject(org.id, 'cancelled');
    const building = await seedBuilding(project);
    const apt1 = await seedApartment(building);
    const apt2 = await seedApartment(building);
    const owner1 = await seedOwner(org.id);
    const owner2 = await seedOwner(org.id);
    await seedOwnership(apt1, owner1);
    await seedOwnership(apt2, owner2);
    const doc = await seedDoc(org.id, { projectId: project });

    await expect(
      svc.createBulk(manager(), { documentId: doc, ownerIds: [owner1, owner2] }),
    ).rejects.toMatchObject({
      response: { error: { code: 'signature_request_project_terminal' } },
    });
    expect(await countRequests(doc, owner1)).toBe(0);
    expect(await countRequests(doc, owner2)).toBe(0);
  }, 30_000);

  it('ALLOWS a bulk against an APPROVED project → owners created (control)', async () => {
    const project = await seedProject(org.id, 'approved');
    const building = await seedBuilding(project);
    const apt1 = await seedApartment(building);
    const apt2 = await seedApartment(building);
    const owner1 = await seedOwner(org.id);
    const owner2 = await seedOwner(org.id);
    await seedOwnership(apt1, owner1);
    await seedOwnership(apt2, owner2);
    const doc = await seedDoc(org.id, { projectId: project });

    const res = await svc.createBulk(manager(), { documentId: doc, ownerIds: [owner1, owner2] });
    expect(res.summary.created).toBe(2);
    expect(await countRequests(doc, owner1)).toBe(1);
    expect(await countRequests(doc, owner2)).toBe(1);
  }, 30_000);
});
