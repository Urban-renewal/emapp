/**
 * E2 Wave-0 PERF — CACHE CORRECTNESS spec (the HARD constraint).
 *
 * The cached value MUST equal the uncached value. This suite proves, against
 * the REAL PostgresCacheProvider (cache_kv) + the REAL DB:
 *
 *   C1 — cache-HIT === fresh-compute for `signatureProgress` (a cached
 *        ProjectsService and an uncached one return deep-equal boards).
 *   C2 — cache-HIT === fresh-compute for `orgStats`.
 *   C3 — COLD read populates the cache (the epoch-stamped envelope exists after).
 *   C4 — a consent-affecting WRITE invalidates: after a sign, the cached read
 *        returns the NEW value, never the stale one (no wrong consent %).
 *   C5 — TENANT ISOLATION: org A's signed signature never appears in org B's
 *        cached board for a same-shaped project (no cross-org key collision).
 *   C6 — agent vs manager orgStats are cached under DISTINCT scope keys (an
 *        agent never reads the org-wide value, and vice-versa).
 *
 * Mechanism, not mock: the cache is the production class over the production
 * table. The "uncached" reference is a second ProjectsService constructed with
 * NO cache (the `new ProjectsService()` path) — its result is the ground truth
 * the cached path must match.
 */
import { randomUUID } from 'node:crypto';

import {
  PostgresCacheProvider,
  encryptOwnerPii,
  owners as ownersTable,
  projects as projectsTable,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsService } from './projects.service';
import { StatsCacheService } from './stats-cache.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let cachedSvc: ProjectsService; // wired with the real cache
let freshSvc: ProjectsService; // no cache — ground truth
let cache: StatsCacheService;
let org: TestOrg;
let orgB: TestOrg;
let managerId: string;

function manager(o: TestOrg, mgrId: string): AccessTokenPayload {
  return {
    sub: mgrId,
    orgId: o.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000c1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

let nidCounter = 700000001;

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
      nationalId: String(nidCounter++),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(ownersTable)
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
      .returning({ id: ownersTable.id });
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

async function seedProjectDoc(
  orgId: string,
  projectId: string,
  uploaderId: string,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'plan.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now())
       RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, uploaderId],
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
  uploaderId: string,
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
        'jti-' + randomUUID(),
        status,
        new Date(Date.now() + SEVEN_DAYS_MS),
        uploaderId,
      ],
    );
  } finally {
    c.release();
  }
}

/** Create a fresh project in an org; returns its id. */
async function seedProject(orgId: string, createdBy: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [p] = await tx
      .insert(projectsTable)
      .values({
        orgId,
        name: `cache-corr-${randomUUID().slice(0, 6)}`,
        type: 'tama38_1',
        createdBy,
        targetSignaturePct: '60.00',
      })
      .returning({ id: projectsTable.id });
    return p!.id;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  cache = new StatsCacheService(new PostgresCacheProvider());
  cachedSvc = new ProjectsService(cache);
  freshSvc = new ProjectsService(); // ground truth — no cache
  const tag = `cache-corr-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('PERF cache — cache-hit === fresh-compute (the HARD constraint)', () => {
  it('C1) signatureProgress: cached HIT deep-equals an uncached fresh compute', async () => {
    const projectId = await seedProject(org.id, managerId);
    const building = await seedBuilding(projectId);
    // apt A: 1 owner, signed → consented. apt B: 1 owner, pending → not.
    const aptA = await seedApartment(building);
    const ownerA = await seedOwner(org.id);
    await seedOwnership(aptA, ownerA);
    const aptB = await seedApartment(building);
    const ownerB = await seedOwner(org.id);
    await seedOwnership(aptB, ownerB);
    const doc = await seedProjectDoc(org.id, projectId, managerId);
    await seedRequest(org.id, doc, ownerA, 'signed', managerId);
    await seedRequest(org.id, doc, ownerB, 'pending', managerId);

    const u = manager(org, managerId);
    const fresh = await freshSvc.signatureProgress(u, projectId); // ground truth
    const cold = await cachedSvc.signatureProgress(u, projectId); // populates cache
    const warm = await cachedSvc.signatureProgress(u, projectId); // HIT

    // The genuinely-new board logic computed correctly...
    expect(fresh.totalApartments).toBe(2);
    expect(fresh.apartmentsConsented).toBe(1);
    expect(fresh.consentedPct).toBe(50);
    // ...and the cached value equals the uncached value, cold AND warm.
    expect(cold).toEqual(fresh);
    expect(warm).toEqual(fresh);
  }, 60_000);

  it('C2) orgStats: cached HIT deep-equals an uncached fresh compute', async () => {
    const u = manager(org, managerId);
    const fresh = await freshSvc.orgStats(u);
    const cold = await cachedSvc.orgStats(u);
    const warm = await cachedSvc.orgStats(u);
    expect(cold).toEqual(fresh);
    expect(warm).toEqual(fresh);
  }, 30_000);

  it('C3) a COLD read populates the cache (the epoch-stamped envelope exists after)', async () => {
    const projectId = await seedProject(org.id, managerId);
    const u = manager(org, managerId);
    const key = cache.signatureProgressKey(projectId);
    // The raw cache provider lets us prove population at the storage layer.
    const raw = new PostgresCacheProvider();
    const board = await cachedSvc.signatureProgress(u, projectId); // cold → populate
    // The value is stored epoch-independently as an envelope { e, v }; its
    // stamped epoch must equal the org's current epoch and its `v` the board.
    const epoch = await raw.get<number>(`stats:epoch:org:${org.id}`);
    const epochNum = typeof epoch === 'number' ? epoch : 0;
    const env = await raw.get<{ e: number; v: typeof board }>(`stats:org:${org.id}:${key}`);
    expect(env).not.toBeNull();
    expect(env!.e).toBe(epochNum);
    expect(env!.v).toEqual(board);
  }, 30_000);

  it('C4) a sign-equivalent WRITE invalidates — the cached read returns the NEW value, not stale', async () => {
    const projectId = await seedProject(org.id, managerId);
    const building = await seedBuilding(projectId);
    const apt = await seedApartment(building);
    const owner = await seedOwner(org.id);
    await seedOwnership(apt, owner);
    const doc = await seedProjectDoc(org.id, projectId, managerId);
    await seedRequest(org.id, doc, owner, 'pending', managerId);

    const u = manager(org, managerId);
    const before = await cachedSvc.signatureProgress(u, projectId); // cold → cached
    expect(before.apartmentsConsented).toBe(0); // pending, not consented

    // Flip the request to signed (the DB side-effect a resident sign produces)
    // then invalidate via the SAME epoch-bump the sign path calls.
    await providerPool.query(
      `UPDATE signature_requests SET status = 'signed' WHERE owner_id = $1`,
      [owner],
    );
    await cache.invalidateOrg(org.id);

    const after = await cachedSvc.signatureProgress(u, projectId); // must recompute
    expect(after.apartmentsConsented).toBe(1); // NEW value — never the stale 0
    // And it equals a fresh uncached compute (correctness preserved post-invalidate).
    const fresh = await freshSvc.signatureProgress(u, projectId);
    expect(after).toEqual(fresh);
  }, 60_000);

  it('C5) TENANT ISOLATION — org B never reads org A`s cached board (no key collision)', async () => {
    // Same-shaped project in BOTH orgs; org A has a signed (consented) apt,
    // org B has a pending (not-consented) apt. If keys collided, B would read
    // A`s consented board.
    const pA = await seedProject(org.id, managerId);
    const bA = await seedBuilding(pA);
    const aptA = await seedApartment(bA);
    const oA = await seedOwner(org.id);
    await seedOwnership(aptA, oA);
    const dA = await seedProjectDoc(org.id, pA, managerId);
    await seedRequest(org.id, dA, oA, 'signed', managerId);

    const mgrB = orgB.users[0]!.id;
    const pB = await seedProject(orgB.id, mgrB);
    const bB = await seedBuilding(pB);
    const aptB = await seedApartment(bB);
    const oB = await seedOwner(orgB.id);
    await seedOwnership(aptB, oB);
    const dB = await seedProjectDoc(orgB.id, pB, mgrB);
    await seedRequest(orgB.id, dB, oB, 'pending', mgrB);

    // Prime A`s cache, then read B.
    const boardA = await cachedSvc.signatureProgress(manager(org, managerId), pA);
    const boardB = await cachedSvc.signatureProgress(manager(orgB, mgrB), pB);

    expect(boardA.apartmentsConsented).toBe(1); // A is consented
    expect(boardB.apartmentsConsented).toBe(0); // B is NOT — no leak from A
    // And B equals its own fresh compute.
    const freshB = await freshSvc.signatureProgress(manager(orgB, mgrB), pB);
    expect(boardB).toEqual(freshB);
  }, 60_000);

  it('C6) orgStats agent vs manager are cached under DISTINCT scope keys', () => {
    const all = cache.orgStatsKey('all');
    const agent1 = cache.orgStatsKey({ agentId: 'a-1' });
    const agent2 = cache.orgStatsKey({ agentId: 'a-2' });
    expect(all).not.toBe(agent1);
    expect(agent1).not.toBe(agent2);
    expect(all).toBe('orgStats:all');
    expect(agent1).toBe('orgStats:agent:a-1');
  });
});
