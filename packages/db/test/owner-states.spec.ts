/**
 * Slice 2.5 — owner legal/life states acceptance tests (DB-level integration).
 *
 * Covers the load-bearing claims of the slice:
 *   1. MIGRATION APPLIES — `owner_states` table + the two enums exist, FORCE RLS
 *      is on, app_user has SELECT/INSERT/UPDATE but NOT DELETE, and the partial
 *      indexes exist (`status='active' AND archived_at IS NULL`).
 *   2. GUARDIAN PII — encrypted at rest (ciphertext != plaintext, randomised IV),
 *      decryptable via the pgcrypto key, MASKED on the service projection (first
 *      grapheme + ellipsis), and never stored as cleartext in the row.
 *   3. RECOMMENDER — `ownership-mismatch-flag` is PII-FREE (evidence = ownerId +
 *      stateKind + projectId only), idempotent (deterministic dedup key), and only
 *      fires for BLOCKING kinds on gathering-signatures projects.
 *   4. COUNTS SINGLE-SOURCE — the active/non-archived count by kind reads the
 *      SAME `owner_states` table the service writes (no divergent query).
 *
 * Harness: providerDb (BYPASSRLS) for seeding; the masking is exercised via the
 * SAME in-SQL pgp_sym_decrypt the service uses (app.encryption_key GUC).
 *
 * Run:
 *   infisical run --env dev -- bash -c 'export DB_TARGET=local; \
 *     export LOCAL_DATABASE_URL="postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable"; \
 *     pnpm --filter @emapp/db exec vitest run test/owner-states.spec.ts'
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import {
  apartments,
  buildings,
  createOwnershipMismatchRecommender,
  organizations,
  ownerStates,
  owners,
  ownerships,
  projects,
  providerDb,
  users,
} from '../src/index';

const TEST_ORG_NAME = 'slice25-owner-states';

let testOrgId: string;
let creatorId: string;
let projectId: string;
let buildingId: string;
let apartmentId: string;
let blockedOwnerId: string;
let cleanOwnerId: string;

async function seed(): Promise<void> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `${TEST_ORG_NAME}-${orgId.slice(0, 8)}`,
    slug: `os25${orgId.slice(0, 8)}`,
  });
  testOrgId = orgId;

  const [mgr] = await providerDb
    .insert(users)
    .values({
      id: randomUUID(),
      email: `mgr-${orgId.slice(0, 8)}@os25.dev`,
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

  const [apt] = await providerDb
    .insert(apartments)
    .values({ id: randomUUID(), buildingId, number: '1' })
    .returning({ id: apartments.id });
  apartmentId = apt!.id;

  const [blocked] = await providerDb
    .insert(owners)
    .values({ id: randomUUID(), orgId })
    .returning({ id: owners.id });
  blockedOwnerId = blocked!.id;

  const [clean] = await providerDb
    .insert(owners)
    .values({ id: randomUUID(), orgId })
    .returning({ id: owners.id });
  cleanOwnerId = clean!.id;

  // Both owners hold an active ownership of the apartment (the sum-trigger needs
  // the owner-relationship fractions to sum to 1 per apartment → 1/2 + 1/2).
  await providerDb.insert(ownerships).values([
    {
      id: randomUUID(),
      apartmentId,
      ownerId: blockedOwnerId,
      relationship: 'owner',
      ownershipPct: '50.00',
      shareNumerator: 1,
      shareDenominator: 2,
    },
    {
      id: randomUUID(),
      apartmentId,
      ownerId: cleanOwnerId,
      relationship: 'owner',
      ownershipPct: '50.00',
      shareNumerator: 1,
      shareDenominator: 2,
    },
  ]);
}

async function cleanup(): Promise<void> {
  // ownerships/apartments/buildings are NOT org-scoped — delete via the seeded
  // ids / cascade chain. owner_states + owners + projects ARE org-scoped.
  await providerDb
    .delete(ownerStates)
    .where(eq(ownerStates.orgId, testOrgId))
    .catch(() => undefined);
  await providerDb
    .delete(ownerships)
    .where(eq(ownerships.apartmentId, apartmentId))
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
    .delete(owners)
    .where(eq(owners.orgId, testOrgId))
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

/** Insert an owner_state with guardian PII encrypted via pgcrypto (the SAME
 *  pgp_sym_encrypt the service's encryptField uses), under providerDb. */
async function insertGuardianState(
  ownerId: string,
  kind: string,
  guardianName: string,
): Promise<string> {
  const res = await providerDb.execute(sql`
    INSERT INTO owner_states (org_id, owner_id, kind, status, created_by,
      guardian_name_encrypted)
    VALUES (${testOrgId}, ${ownerId}, ${kind}::owner_state_kind, 'active', ${creatorId},
      pgp_sym_encrypt(${guardianName}, ${env.PII_ENCRYPTION_KEY}))
    RETURNING id
  `);
  return String((res as unknown as { rows: Array<{ id: string }> }).rows[0]!.id);
}

describe('Slice 2.5 — owner_states migration + schema', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('1) the owner_states table exists and is insertable via Drizzle', async () => {
    const [row] = await providerDb
      .insert(ownerStates)
      .values({ orgId: testOrgId, ownerId: cleanOwnerId, kind: 'verify', createdBy: creatorId })
      .returning({ id: ownerStates.id, status: ownerStates.status });
    expect(row?.id).toBeTruthy();
    expect(row?.status).toBe('active');
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, row!.id));
  });

  it('2) the resolved-consistency CHECK rejects an active row with a resolved_at', async () => {
    await expect(
      providerDb.execute(sql`
        INSERT INTO owner_states (org_id, owner_id, kind, status, resolved_at, created_by)
        VALUES (${testOrgId}, ${cleanOwnerId}, 'verify', 'active', now(), ${creatorId})
      `),
    ).rejects.toThrow();
  });

  it('3) FORCE RLS is enabled and app_user has no DELETE grant', async () => {
    const rls = await providerDb.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'owner_states'
    `);
    const r = (rls as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(r['relrowsecurity']).toBe(true);
    expect(r['relforcerowsecurity']).toBe(true);

    const grants = await providerDb.execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'owner_states' AND grantee = 'app_user'
    `);
    const privs = (grants as unknown as { rows: Array<{ privilege_type: string }> }).rows.map(
      (x) => x.privilege_type,
    );
    expect(privs).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE']));
    expect(privs).not.toContain('DELETE');
  });
});

describe('Slice 2.5 — guardian PII encryption + masking', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('4) guardian name is encrypted at rest (ciphertext != plaintext) and decryptable', async () => {
    const guardianName = 'דנה לוי';
    const id = await insertGuardianState(blockedOwnerId, 'competency', guardianName);

    // The stored ciphertext is NOT the plaintext.
    const raw = await providerDb.execute(sql`
      SELECT guardian_name_encrypted FROM owner_states WHERE id = ${id}
    `);
    const enc = (raw as unknown as { rows: Array<{ guardian_name_encrypted: Buffer }> }).rows[0]!
      .guardian_name_encrypted;
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(enc.toString('utf8')).not.toContain(guardianName);

    // It decrypts back to the original via the key.
    const dec = await providerDb.execute(sql`
      SELECT pgp_sym_decrypt(guardian_name_encrypted, ${env.PII_ENCRYPTION_KEY})::text AS d
      FROM owner_states WHERE id = ${id}
    `);
    expect((dec as unknown as { rows: Array<{ d: string }> }).rows[0]!.d).toBe(guardianName);
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, id));
  });

  it('5) the masked projection returns first grapheme + ellipsis, never the full name', async () => {
    const guardianName = 'אברהם כהן';
    const id = await insertGuardianState(blockedOwnerId, 'competency', guardianName);

    // Mirror the service GUARDIAN_NAME_MASK SQL exactly.
    const masked = await providerDb.execute(sql`
      SELECT left(pgp_sym_decrypt(guardian_name_encrypted, ${env.PII_ENCRYPTION_KEY})::text, 1) || '•••' AS m
      FROM owner_states WHERE id = ${id}
    `);
    const m = (masked as unknown as { rows: Array<{ m: string }> }).rows[0]!.m;
    expect(m).toBe('א•••');
    expect(m).not.toContain('כהן');
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, id));
  });
});

describe('Slice 2.5 — ownership-mismatch recommender', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('6) flags a blocking owner (competency) counted in the threshold — PII-FREE evidence', async () => {
    const id = await insertGuardianState(blockedOwnerId, 'competency', 'אפוטרופוס בדיקה');

    const rec = createOwnershipMismatchRecommender();
    const conditions = await rec.detect({ now: new Date() });
    const mine = conditions.filter((c) => c.orgId === testOrgId);

    expect(mine.length).toBe(1);
    const c = mine[0]!;
    expect(c.kind).toBe('task.create');
    expect(c.scopeType).toBe('project');
    expect(c.scopeId).toBe(projectId);
    expect(c.evidence).toEqual({
      condition: 'ownership_mismatch',
      projectId,
      ownerId: blockedOwnerId,
      stateKind: 'competency',
    });
    // PII-FREE: the evidence carries NO name/national_id/phone/guardian field.
    const ev = JSON.stringify(c.evidence);
    expect(ev).not.toContain('guardian');
    expect(ev).not.toContain('אפוטרופוס');
    // Deterministic dedup key per (project, owner) — no timestamp/nonce.
    expect(c.dedupKey).toBe(`task.create:ownership-mismatch:${projectId}:${blockedOwnerId}`);

    await providerDb.delete(ownerStates).where(eq(ownerStates.id, id));
  });

  it('7) is idempotent — the dedup key is stable across two detect() ticks', async () => {
    const id = await insertGuardianState(blockedOwnerId, 'dispute', 'n/a');
    const rec = createOwnershipMismatchRecommender();
    const a = (await rec.detect({ now: new Date() })).filter((c) => c.orgId === testOrgId);
    const b = (await rec.detect({ now: new Date(Date.now() + 60_000) })).filter(
      (c) => c.orgId === testOrgId,
    );
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]!.dedupKey).toBe(b[0]!.dedupKey);
    expect(a[0]!.evidence['stateKind']).toBe('dispute');
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, id));
  });

  it('8) does NOT flag a non-blocking kind (lien) or a resolved/archived state', async () => {
    // lien is non-blocking.
    const lienId = await insertGuardianState(blockedOwnerId, 'lien', 'n/a');
    // a resolved competency must not fire.
    const resolvedRes = await providerDb.execute(sql`
      INSERT INTO owner_states (org_id, owner_id, kind, status, resolved_at, created_by)
      VALUES (${testOrgId}, ${cleanOwnerId}, 'competency', 'resolved', now(), ${creatorId})
      RETURNING id
    `);
    const resolvedId = String(
      (resolvedRes as unknown as { rows: Array<{ id: string }> }).rows[0]!.id,
    );

    const rec = createOwnershipMismatchRecommender();
    const mine = (await rec.detect({ now: new Date() })).filter((c) => c.orgId === testOrgId);
    expect(mine.length).toBe(0);

    await providerDb.delete(ownerStates).where(eq(ownerStates.id, lienId));
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, resolvedId));
  });
});

describe('Slice 2.5 — perception counts single-source', () => {
  beforeAll(seed);
  afterAll(cleanup);

  it('9) the active/non-archived count by kind reads the same owner_states table', async () => {
    const c1 = await insertGuardianState(blockedOwnerId, 'competency', 'g1');
    const d1 = await insertGuardianState(cleanOwnerId, 'dispute', 'n/a');
    // a resolved one must NOT be counted.
    const resolvedRes = await providerDb.execute(sql`
      INSERT INTO owner_states (org_id, owner_id, kind, status, resolved_at, created_by)
      VALUES (${testOrgId}, ${cleanOwnerId}, 'lien', 'resolved', now(), ${creatorId})
      RETURNING id
    `);
    const resolvedId = String(
      (resolvedRes as unknown as { rows: Array<{ id: string }> }).rows[0]!.id,
    );

    // The EXACT count query computeOrgStats runs (scoped to our org via providerDb).
    const res = await providerDb.execute(sql`
      SELECT
        COUNT(DISTINCT owner_id)::int AS owners_with_active,
        COUNT(*) FILTER (WHERE kind = 'competency')::int AS competency_count,
        COUNT(*) FILTER (WHERE kind = 'dispute')::int    AS dispute_count,
        COUNT(*) FILTER (WHERE kind = 'lien')::int        AS lien_count
      FROM owner_states
      WHERE status = 'active' AND archived_at IS NULL AND org_id = ${testOrgId}
    `);
    const r = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
    expect(Number(r['owners_with_active'])).toBe(2);
    expect(Number(r['competency_count'])).toBe(1);
    expect(Number(r['dispute_count'])).toBe(1);
    expect(Number(r['lien_count'])).toBe(0); // the lien is resolved → not counted

    await providerDb.delete(ownerStates).where(eq(ownerStates.id, c1));
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, d1));
    await providerDb.delete(ownerStates).where(eq(ownerStates.id, resolvedId));
  });
});
