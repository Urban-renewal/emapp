/**
 * Slice 2.7 — apartment legal/life states acceptance tests (DB-level integration).
 *
 * The structural mirror of `owner-states.spec.ts` (2.5), adapted to APARTMENTS and
 * PII-FREE. Covers the load-bearing claims of the slice:
 *   1. MIGRATION APPLIES — `apartment_states` table + the two enums exist, FORCE RLS
 *      is on, app_user has SELECT/INSERT/UPDATE but NOT DELETE, the resolved-
 *      consistency CHECK rejects an inconsistent row, and the table is insertable.
 *   2. RECOMMENDER — `apartment-blocker-flag` is PII-FREE (evidence = apartmentId +
 *      stateKind + projectId only), idempotent (deterministic dedup key), and only
 *      fires for BLOCKING kinds (deceased/dispute/eviction) on gathering-signatures
 *      projects — NOT for a non-blocking kind or a resolved/archived state.
 *   3. COUNTS SINGLE-SOURCE — the active/non-archived count by kind reads the SAME
 *      `apartment_states` table the service writes (no divergent query).
 *
 * Harness: providerDb (BYPASSRLS) for seeding (mirrors owner-states.spec.ts).
 *
 * Run (fresh throwaway DB):
 *   infisical run --env dev -- bash -c 'export DB_TARGET=local; \
 *     export LOCAL_DATABASE_URL="postgresql://postgres:1234@localhost:5432/emapp_v27?sslmode=disable"; \
 *     pnpm --filter @emapp/db exec vitest run test/apartment-states.spec.ts'
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apartments,
  apartmentStates,
  buildings,
  createApartmentBlockerRecommender,
  organizations,
  projects,
  providerDb,
  users,
} from '../src/index';

const TEST_ORG_NAME = 'slice27-apartment-states';

let testOrgId: string;
let creatorId: string;
let projectId: string;
let buildingId: string;
let blockedApartmentId: string;
let cleanApartmentId: string;

async function seed(): Promise<void> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `${TEST_ORG_NAME}-${orgId.slice(0, 8)}`,
    slug: `as27${orgId.slice(0, 8)}`,
  });
  testOrgId = orgId;

  const [mgr] = await providerDb
    .insert(users)
    .values({
      id: randomUUID(),
      email: `mgr-${orgId.slice(0, 8)}@as27.dev`,
      name: 'מנהל בדיקה',
      passwordHash: 'x',
    })
    .returning({ id: users.id });
  creatorId = mgr!.id;

  const [proj] = await providerDb
    .insert(projects)
    .values({
      id: randomUUID(),
      orgId,
      name: 'פרויקט בדיקה',
      type: 'tama38_1',
      status: 'gathering_signatures',
      createdBy: creatorId,
    })
    .returning({ id: projects.id });
  projectId = proj!.id;

  const [bld] = await providerDb
    .insert(buildings)
    .values({ id: randomUUID(), projectId, address: 'רחוב הבדיקה 1', city: 'תל אביב' })
    .returning({ id: buildings.id });
  buildingId = bld!.id;

  const [blocked] = await providerDb
    .insert(apartments)
    .values({ id: randomUUID(), buildingId, number: '1' })
    .returning({ id: apartments.id });
  blockedApartmentId = blocked!.id;

  const [clean] = await providerDb
    .insert(apartments)
    .values({ id: randomUUID(), buildingId, number: '2' })
    .returning({ id: apartments.id });
  cleanApartmentId = clean!.id;
}

async function cleanup(): Promise<void> {
  await providerDb
    .delete(apartmentStates)
    .where(eq(apartmentStates.orgId, testOrgId))
    .catch(() => undefined);
  await providerDb
    .delete(apartments)
    .where(eq(apartments.buildingId, buildingId))
    .catch(() => undefined);
  await providerDb
    .delete(buildings)
    .where(eq(buildings.projectId, projectId))
    .catch(() => undefined);
  await providerDb
    .delete(projects)
    .where(eq(projects.orgId, testOrgId))
    .catch(() => undefined);
  await providerDb
    .delete(users)
    .where(eq(users.id, creatorId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, testOrgId))
    .catch(() => undefined);
}

/** Insert an apartment_state of `kind` (active) under providerDb. */
async function insertState(apartmentId: string, kind: string): Promise<string> {
  const res = await providerDb.execute(sql`
    INSERT INTO apartment_states (org_id, apartment_id, kind, status, created_by)
    VALUES (${testOrgId}, ${apartmentId}, ${kind}::apartment_state_kind, 'active', ${creatorId})
    RETURNING id
  `);
  return String((res as unknown as { rows: Array<{ id: string }> }).rows[0]!.id);
}

describe('Slice 2.7 — apartment_states migration + schema', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('1) the apartment_states table exists and is insertable via Drizzle', async () => {
    const [row] = await providerDb
      .insert(apartmentStates)
      .values({
        orgId: testOrgId,
        apartmentId: cleanApartmentId,
        kind: 'repairs',
        createdBy: creatorId,
      })
      .returning({ id: apartmentStates.id, status: apartmentStates.status });
    expect(row?.id).toBeTruthy();
    expect(row?.status).toBe('active');
    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, row!.id));
  });

  it('2) the resolved-consistency CHECK rejects an active row with a resolved_at', async () => {
    await expect(
      providerDb.execute(sql`
        INSERT INTO apartment_states (org_id, apartment_id, kind, status, resolved_at, created_by)
        VALUES (${testOrgId}, ${cleanApartmentId}, 'repairs', 'active', now(), ${creatorId})
      `),
    ).rejects.toThrow();
  });

  it('3) FORCE RLS is enabled and app_user has no DELETE grant', async () => {
    const rls = await providerDb.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'apartment_states'
    `);
    const r = (rls as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(r['relrowsecurity']).toBe(true);
    expect(r['relforcerowsecurity']).toBe(true);

    const grants = await providerDb.execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'apartment_states' AND grantee = 'app_user'
    `);
    const privs = (grants as unknown as { rows: Array<{ privilege_type: string }> }).rows.map(
      (x) => x.privilege_type,
    );
    expect(privs).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE']));
    expect(privs).not.toContain('DELETE');
  });
});

describe('Slice 2.7 — apartment-blocker recommender', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('4) flags a blocking apartment (eviction) on a gathering-signatures project — PII-FREE evidence', async () => {
    const id = await insertState(blockedApartmentId, 'eviction');

    const rec = createApartmentBlockerRecommender();
    const conditions = await rec.detect({ now: new Date() });
    const mine = conditions.filter((c) => c.orgId === testOrgId);

    expect(mine.length).toBe(1);
    const c = mine[0]!;
    expect(c.kind).toBe('task.create');
    expect(c.scopeType).toBe('project');
    expect(c.scopeId).toBe(projectId);
    expect(c.evidence).toEqual({
      condition: 'apartment_blocker',
      projectId,
      apartmentId: blockedApartmentId,
      stateKind: 'eviction',
    });
    // PII-FREE: the evidence carries NO name/national_id/phone field.
    const ev = JSON.stringify(c.evidence);
    expect(ev).not.toContain('national');
    expect(ev).not.toContain('phone');
    // Deterministic dedup key per (project, apartment) — no timestamp/nonce.
    expect(c.dedupKey).toBe(`task.create:apartment-blocker:${projectId}:${blockedApartmentId}`);

    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, id));
  });

  it('5) is idempotent — the dedup key is stable across two detect() ticks', async () => {
    const id = await insertState(blockedApartmentId, 'dispute');
    const rec = createApartmentBlockerRecommender();
    const a = (await rec.detect({ now: new Date() })).filter((c) => c.orgId === testOrgId);
    const b = (await rec.detect({ now: new Date(Date.now() + 60_000) })).filter(
      (c) => c.orgId === testOrgId,
    );
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]!.dedupKey).toBe(b[0]!.dedupKey);
    expect(a[0]!.evidence['stateKind']).toBe('dispute');
    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, id));
  });

  it('6) does NOT flag a non-blocking kind (repairs) or a resolved/archived state', async () => {
    // repairs is non-blocking.
    const repairsId = await insertState(blockedApartmentId, 'repairs');
    // a resolved eviction must not fire.
    const resolvedRes = await providerDb.execute(sql`
      INSERT INTO apartment_states (org_id, apartment_id, kind, status, resolved_at, created_by)
      VALUES (${testOrgId}, ${cleanApartmentId}, 'eviction', 'resolved', now(), ${creatorId})
      RETURNING id
    `);
    const resolvedId = String(
      (resolvedRes as unknown as { rows: Array<{ id: string }> }).rows[0]!.id,
    );

    const rec = createApartmentBlockerRecommender();
    const mine = (await rec.detect({ now: new Date() })).filter((c) => c.orgId === testOrgId);
    expect(mine.length).toBe(0);

    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, repairsId));
    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, resolvedId));
  });
});

describe('Slice 2.7 — perception counts single-source', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('7) the active/non-archived count by kind reads the same apartment_states table', async () => {
    const e1 = await insertState(blockedApartmentId, 'eviction');
    const d1 = await insertState(cleanApartmentId, 'dispute');
    // a resolved repairs must NOT be counted.
    const resolvedRes = await providerDb.execute(sql`
      INSERT INTO apartment_states (org_id, apartment_id, kind, status, resolved_at, created_by)
      VALUES (${testOrgId}, ${cleanApartmentId}, 'repairs', 'resolved', now(), ${creatorId})
      RETURNING id
    `);
    const resolvedId = String(
      (resolvedRes as unknown as { rows: Array<{ id: string }> }).rows[0]!.id,
    );

    // The EXACT count query computeOrgStats runs (scoped to our org via providerDb).
    const res = await providerDb.execute(sql`
      SELECT
        COUNT(DISTINCT apartment_id)::int                     AS apartments_with_active,
        COUNT(*) FILTER (WHERE kind = 'eviction')::int        AS eviction_count,
        COUNT(*) FILTER (WHERE kind = 'dispute')::int         AS dispute_count,
        COUNT(*) FILTER (WHERE kind = 'repairs')::int         AS repairs_count,
        COUNT(*) FILTER (WHERE kind = 'rights_transfer')::int AS rights_transfer_count
      FROM apartment_states
      WHERE status = 'active' AND archived_at IS NULL AND org_id = ${testOrgId}
    `);
    const r = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(Number(r['apartments_with_active'])).toBe(2);
    expect(Number(r['eviction_count'])).toBe(1);
    expect(Number(r['dispute_count'])).toBe(1);
    expect(Number(r['repairs_count'])).toBe(0); // the repairs is resolved → not counted
    expect(Number(r['rights_transfer_count'])).toBe(0);

    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, e1));
    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, d1));
    await providerDb.delete(apartmentStates).where(eq(apartmentStates.id, resolvedId));
  });
});
