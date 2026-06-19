/**
 * E2 Wave-1 B5 — project status STATE MACHINE + OPTIMISTIC CONCURRENCY.
 *
 * Service-level integration spec against the real DB (same harness as
 * projects-renewal-fields.spec.ts: instantiate ProjectsService directly, seed
 * via createTestOrg, no Nest harness). Pins TWO halves of one slice:
 *
 *  (i) STATUS STATE MACHINE over the D.18 enum — every INVALID edge is rejected
 *      `invalid_status_transition` (409); every VALID edge is allowed; a same→
 *      same write is a no-op; a `→approved` edge is rejected `threshold_not_met`
 *      when share-weighted consent has NOT met target and allowed when it has;
 *      a NON-status field update is unaffected by the gate.
 *
 *  (ii) OPTIMISTIC CONCURRENCY — a correct `expectedUpdatedAt` succeeds and the
 *       response carries the NEW `updatedAt`; a wrong/old value → `stale_write`
 *       (409); omitting it skips the check (back-compat).
 *
 * Status is mutated directly via providerPool (BYPASSRLS) to PLACE a project in
 * a chosen start state — the same ground-truth pattern the B0 board spec uses
 * for seeding. The consent for the `→approved` precondition is seeded with the
 * SAME share-weighted fixtures the B0 board spec uses (apartment + owner +
 * project doc + signed/pending requests).
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import type { ProjectStatus, UpdateProject } from '@emapp/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let orgA: TestOrg;
let managerId: string;
const svc = new ProjectsService();

const TEST_SID = '00000000-0000-4000-8000-00000000bbb5';

function manager(o: TestOrg): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role: 'manager',
    sid: TEST_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

let nidCounter = 500000001;
function natId(): string {
  return String(nidCounter++);
}

/** Create a fresh project (status 'planning' by default) and return its id. */
async function freshProject(type = 'tama38_1'): Promise<string> {
  const created = await svc.create(manager(orgA), {
    name: `b5-${randomUUID().slice(0, 8)}`,
    type: type as 'tama38_1',
  });
  return created.id;
}

/** Place a project directly in a chosen status (BYPASSRLS ground-truth). */
async function setStatus(projectId: string, status: ProjectStatus): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE projects SET status = $2 WHERE id = $1`, [projectId, status]);
  } finally {
    c.release();
  }
}

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
        'jti-b5-' + randomUUID(),
        status,
        new Date(Date.now() + SEVEN_DAYS_MS),
        managerId,
      ],
    );
  } finally {
    c.release();
  }
}

/** Drive a project to a chosen consentedPct by seeding apartments + owners +
 *  signed/pending requests. One signed apartment + (n-1) pending → 1/n. */
async function seedConsent(projectId: string, signed: number, total: number): Promise<void> {
  const building = await seedBuilding(projectId);
  const doc = await seedProjectDoc(orgA.id, projectId);
  for (let i = 0; i < total; i += 1) {
    const apt = await seedApartment(building);
    const owner = await seedOwner(orgA.id);
    await seedOwnership(apt, owner);
    await seedRequest(orgA.id, doc, owner, i < signed ? 'signed' : 'pending');
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`B5-${ts}`, `b5-${ts}`);
  managerId = orgA.users[0]!.id;
}, 120_000);

// ───────────────────────────────────────────────────────────────────────────
// (i) STATE MACHINE — invalid edges
// ───────────────────────────────────────────────────────────────────────────
describe('B5 state-machine — INVALID transitions rejected (409)', () => {
  const invalid: Array<[ProjectStatus, ProjectStatus]> = [
    ['completed', 'planning'], // terminal → anything
    ['completed', 'in_construction'],
    ['cancelled', 'planning'], // terminal → anything
    ['cancelled', 'approved'],
    ['planning', 'approved'], // skip gathering_signatures
    ['planning', 'in_construction'], // skip stages
    ['planning', 'completed'], // skip stages
    ['gathering_signatures', 'in_construction'], // skip approved
    ['gathering_signatures', 'completed'],
    ['approved', 'planning'], // backward
    ['approved', 'completed'], // skip in_construction
    ['in_construction', 'approved'], // backward
    ['in_construction', 'planning'], // backward
  ];

  it.each(invalid)(
    '%s → %s is rejected invalid_status_transition',
    async (from, to) => {
      const id = await freshProject();
      await setStatus(id, from);
      await expect(svc.update(manager(orgA), id, { status: to })).rejects.toMatchObject({
        response: { error: { code: 'invalid_status_transition' } },
      });
    },
    30_000,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (i) STATE MACHINE — valid edges
// ───────────────────────────────────────────────────────────────────────────
describe('B5 state-machine — VALID transitions allowed', () => {
  // approved is excluded here (it carries the metThreshold precondition, tested
  // separately). Every other forward / cancel edge is a pure allow.
  const valid: Array<[ProjectStatus, ProjectStatus]> = [
    ['planning', 'gathering_signatures'],
    ['planning', 'cancelled'],
    ['gathering_signatures', 'cancelled'],
    ['approved', 'in_construction'],
    ['approved', 'cancelled'],
    ['in_construction', 'completed'],
    ['in_construction', 'cancelled'],
  ];

  it.each(valid)(
    '%s → %s is allowed',
    async (from, to) => {
      const id = await freshProject();
      await setStatus(id, from);
      const updated = await svc.update(manager(orgA), id, { status: to });
      expect(updated.status).toBe(to);
    },
    30_000,
  );

  it('same→same status is a no-op (allowed) — gathering_signatures → gathering_signatures', async () => {
    const id = await freshProject();
    await setStatus(id, 'gathering_signatures');
    const updated = await svc.update(manager(orgA), id, { status: 'gathering_signatures' });
    expect(updated.status).toBe('gathering_signatures');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// (i) the →approved metThreshold LEGAL GATE
// ───────────────────────────────────────────────────────────────────────────
describe('B5 state-machine — →approved metThreshold precondition', () => {
  it('rejects gathering_signatures → approved when metThreshold=false (consent below target)', async () => {
    const id = await freshProject();
    await setStatus(id, 'gathering_signatures');
    await setTarget(id, 66);
    await seedConsent(id, 1, 3); // 1/3 = 33% < 66% target → NOT met
    await expect(svc.update(manager(orgA), id, { status: 'approved' })).rejects.toMatchObject({
      response: { error: { code: 'threshold_not_met' } },
    });
  }, 60_000);

  it('allows gathering_signatures → approved when metThreshold=true (consent >= target)', async () => {
    const id = await freshProject();
    await setStatus(id, 'gathering_signatures');
    await setTarget(id, 33);
    await seedConsent(id, 1, 3); // 1/3 = 33% >= 33% target → MET
    const updated = await svc.update(manager(orgA), id, { status: 'approved' });
    expect(updated.status).toBe('approved');
  }, 60_000);

  it('rejects →approved when NO target is set (metThreshold is false for null target)', async () => {
    const id = await freshProject();
    await setStatus(id, 'gathering_signatures');
    await setTarget(id, null);
    await seedConsent(id, 3, 3); // 100% consent, but null target → metThreshold false
    await expect(svc.update(manager(orgA), id, { status: 'approved' })).rejects.toMatchObject({
      response: { error: { code: 'threshold_not_met' } },
    });
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// (i) non-status updates are UNAFFECTED by the gate
// ───────────────────────────────────────────────────────────────────────────
describe('B5 state-machine — non-status update unaffected', () => {
  it('a name-only update on a completed (terminal) project still succeeds', async () => {
    const id = await freshProject();
    await setStatus(id, 'completed'); // terminal: any status change would be rejected
    const patch: UpdateProject = { name: 'renamed b5' };
    const updated = await svc.update(manager(orgA), id, patch);
    expect(updated.name).toBe('renamed b5');
    expect(updated.status).toBe('completed');
  }, 30_000);

  it('a status field EQUAL to current alongside other fields is a no-op (no rejection)', async () => {
    const id = await freshProject();
    await setStatus(id, 'completed');
    const updated = await svc.update(manager(orgA), id, {
      status: 'completed',
      description: 'note',
    });
    expect(updated.description).toBe('note');
    expect(updated.status).toBe('completed');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// (ii) OPTIMISTIC CONCURRENCY
// ───────────────────────────────────────────────────────────────────────────
describe('B5 optimistic-concurrency — expectedUpdatedAt', () => {
  it('succeeds with the CORRECT expectedUpdatedAt and returns a NEW updatedAt', async () => {
    const id = await freshProject();
    const before = await svc.get(manager(orgA), id);
    const updated = await svc.update(manager(orgA), id, {
      name: 'concurrency ok',
      expectedUpdatedAt: before.updatedAt,
    });
    expect(updated.name).toBe('concurrency ok');
    // The response carries the NEW updated_at, strictly newer than the read one.
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    );
  }, 30_000);

  it('rejects stale_write (409) on a WRONG/old expectedUpdatedAt', async () => {
    const id = await freshProject();
    const stale = new Date('2000-01-01T00:00:00.000Z');
    await expect(
      svc.update(manager(orgA), id, { name: 'should fail', expectedUpdatedAt: stale }),
    ).rejects.toMatchObject({ response: { error: { code: 'stale_write' } } });
  }, 30_000);

  it('chaining: a second edit must use the updatedAt returned by the first', async () => {
    const id = await freshProject();
    const before = await svc.get(manager(orgA), id);
    const first = await svc.update(manager(orgA), id, {
      name: 'edit one',
      expectedUpdatedAt: before.updatedAt,
    });
    // Reusing the STALE (original) token now fails — the row moved on.
    await expect(
      svc.update(manager(orgA), id, {
        name: 'edit two stale',
        expectedUpdatedAt: before.updatedAt,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'stale_write' } } });
    // The FRESH token from the first response succeeds.
    const second = await svc.update(manager(orgA), id, {
      name: 'edit two fresh',
      expectedUpdatedAt: first.updatedAt,
    });
    expect(second.name).toBe('edit two fresh');
  }, 30_000);

  it('OMITTING expectedUpdatedAt skips the concurrency check (back-compat)', async () => {
    const id = await freshProject();
    const updated = await svc.update(manager(orgA), id, { name: 'no version field' });
    expect(updated.name).toBe('no version field');
  }, 30_000);

  it('a real not-found id still throws not_found even with expectedUpdatedAt present', async () => {
    const missing = randomUUID();
    await expect(
      svc.update(manager(orgA), missing, { name: 'x', expectedUpdatedAt: new Date() }),
    ).rejects.toMatchObject({ response: { error: { code: 'not_found' } } });
  }, 30_000);
});
