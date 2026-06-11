/**
 * DISCOVERY RECORDS — S3c acceptance tests (TEST-AUTHOR, independent, RED-first).
 *
 * SPEC ("renter → discovery-source", DESIGN-project-model-and-autosetup.md
 * §2 + §6): a "renter"/occupant is NOT an owner/signer. It is a DISCOVERY
 * SOURCE attached to an APARTMENT — a field worker spoke to whoever lives
 * there to learn who the owner is. The fix introduces a new apartment-attached
 * table `discovery_records`:
 *   - id, org_id, apartment_id (FK → apartments, ON DELETE CASCADE)
 *   - status text, CHECK in the closed enum
 *       ('not_visited','no_answer','spoke_to_occupant','owner_identified','refused')
 *       DEFAULT 'not_visited'
 *   - notes text NULL (free-text)
 *   - recording_ref text NULL + transcript text NULL — DEFERRED slots (§6),
 *     never populated this slice
 *   - created_by, created_at / updated_at / archived_at
 *   - RLS-scoped via apartment → building → project → org (Template B, the
 *     same parent-chain isolation building_sections uses — migration 0035).
 * The migration also MIGRATES every existing `ownerships.relationship='renter'`
 * row → a discovery_records row (status 'spoke_to_occupant') on the SAME
 * apartment + DELETEs those renter ownership rows. After the fix, occupants
 * live ONLY in discovery_records (NOT in `owners`/`ownerships`), so an occupant
 * can NEVER be a signature recipient.
 *
 * These tests are written from the SPEC, BEFORE the builder creates the table
 * / migration. They are EXPECTED to be RED against the CURRENT schema:
 *   - `discovery_records` does NOT exist → 42P01 undefined_table.
 * They go GREEN once the builder lands the table + CHECK + RLS + the
 * renter→discovery migration.
 *
 * Level: DB-level integration (the `owner-shells.spec.ts` style — providerDb /
 * raw SQL, with the building→apartment seeding from owner-renter.spec.ts).
 * The new table is exercised via raw SQL (it has no Drizzle export yet), so
 * this file COMPILES today and fails at RUNTIME with the table-missing error —
 * a clean reproduce-before-fix RED.
 *
 * DO NOT modify any implementation/schema/migration file to make these pass —
 * that is the builder's job. This file only asserts the target behavior.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/db exec \
 *     vitest run test/discovery-records.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../src/client';
import {
  apartments,
  buildings,
  owners,
  organizations,
  projects,
  users,
  memberships,
  providerDb,
} from '../src/index';

const TEST_ORG_NAME = 's3c-discovery';

let testOrgId: string;
let creatorId: string;
let projectId: string;

/** Org + a manager user + a membership + one project — the minimal scope chain
 *  needed so an apartment has a project (→ building → project → org) for the
 *  RLS parent-chain. All via providerDb (BYPASSRLS) so seeding is unobstructed. */
async function seedOrgScaffold(): Promise<void> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `${TEST_ORG_NAME}-${orgId.slice(0, 8)}`,
    slug: `disc${orgId.slice(0, 8)}`,
  });
  testOrgId = orgId;

  const [mgr] = await providerDb
    .insert(users)
    .values({
      email: `disc-mgr-${orgId.slice(0, 8)}@test.local`,
      name: 'Discovery Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  creatorId = mgr!.id;

  await providerDb.insert(memberships).values({
    userId: creatorId,
    orgId: testOrgId,
    role: 'manager',
    isPrimary: true,
    acceptedAt: new Date(),
  });

  const [proj] = await providerDb
    .insert(projects)
    .values({
      orgId: testOrgId,
      name: `${TEST_ORG_NAME} Project`,
      type: 'tama38_1',
      createdBy: creatorId,
    })
    .returning({ id: projects.id });
  projectId = proj!.id;
}

/** A fresh apartment (new building) per call — isolation, no unique-index
 *  collisions. Returns the apartment id. providerDb (BYPASSRLS). */
async function seedApartment(): Promise<string> {
  const [bld] = await providerDb
    .insert(buildings)
    .values({
      projectId,
      address: `Discovery ${Date.now()}-${Math.random()}`,
      city: 'Tel Aviv',
    })
    .returning({ id: buildings.id });
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId: bld!.id, number: `D-${Date.now()}-${Math.random()}` })
    .returning({ id: apartments.id });
  return apt!.id;
}

async function cleanup(): Promise<void> {
  // Best-effort, child-first. discovery_records may not exist yet (RED state) —
  // swallow that. Everything below the org cascades from the org delete anyway,
  // but we clear owners/ownerships explicitly (owners restricts org delete).
  await providerDb
    .execute(sql`DELETE FROM discovery_records WHERE org_id = ${testOrgId}`)
    .catch(() => undefined);
  await providerDb
    .execute(
      sql`DELETE FROM ownerships WHERE owner_id IN (SELECT id FROM owners WHERE org_id = ${testOrgId})`,
    )
    .catch(() => undefined);
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, testOrgId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, testOrgId))
    .catch(() => undefined);
}

beforeAll(async () => {
  await seedOrgScaffold();
}, 120_000);

afterAll(async () => {
  await cleanup();
});

// ===========================================================================
// TEST #1 — create a discovery record on an apartment (RED NOW: 42P01)
// ===========================================================================
describe('discovery_records — apartment-attached discovery source', () => {
  it('1) creates a discovery record on an apartment (status + free-text notes) and reads back', async () => {
    // SPEC: a discovery record is attached to an APARTMENT, carries a status
    // from the closed enum + free-text notes. Today the table does NOT exist,
    // so this INSERT fails with 42P01 undefined_table — that failure IS the gap.
    const aptId = await seedApartment();

    const inserted = await providerDb.execute<{ id: string; status: string; notes: string | null }>(
      sql`
        INSERT INTO discovery_records (org_id, apartment_id, status, notes, created_by)
        VALUES (${testOrgId}, ${aptId}, 'spoke_to_occupant', ${'דיברתי עם השוכר; הבעלים גר בחו״ל'}, ${creatorId})
        RETURNING id, status, notes
      `,
    );
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]!.status).toBe('spoke_to_occupant');
    expect(inserted.rows[0]!.notes).toBe('דיברתי עם השוכר; הבעלים גר בחו״ל');

    // Reads back as a genuine, query-able apartment-attached row.
    const back = await providerDb.execute<{
      id: string;
      apartment_id: string;
      status: string;
      notes: string | null;
      recording_ref: string | null;
      transcript: string | null;
    }>(
      sql`SELECT id, apartment_id, status, notes, recording_ref, transcript
          FROM discovery_records WHERE id = ${inserted.rows[0]!.id} LIMIT 1`,
    );
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0]!.apartment_id).toBe(aptId);
    // §6 DEFERRED slots — present in the schema but never populated this slice.
    expect(back.rows[0]!.recording_ref).toBeNull();
    expect(back.rows[0]!.transcript).toBeNull();
  }, 30_000);

  // ===========================================================================
  // TEST #2 — status CHECK is enforced (out-of-enum rejected)
  // ===========================================================================
  it('2) rejects an out-of-enum status (the CHECK constraint is enforced)', async () => {
    const aptId = await seedApartment();
    // 'owner' is NOT a discovery status — the closed set is
    // ('not_visited','no_answer','spoke_to_occupant','owner_identified','refused').
    // A non-member value must be rejected by the CHECK (SQLSTATE 23514).
    const err = await providerDb
      .execute(
        sql`INSERT INTO discovery_records (org_id, apartment_id, status, created_by)
            VALUES (${testOrgId}, ${aptId}, 'definitely_not_a_status', ${creatorId})`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeTruthy();
    const code =
      (err as { cause?: { code?: string }; code?: string }).cause?.code ??
      (err as { code?: string }).code;
    // 23514 = check_violation. (RED now: the table is missing → 42P01 instead;
    // documented as table-missing until the builder lands the CHECK.)
    expect(code).toBe('23514');
  }, 30_000);

  // ===========================================================================
  // TEST #3 — status DEFAULT is 'not_visited'
  // ===========================================================================
  it("3) defaults status to 'not_visited' when omitted", async () => {
    const aptId = await seedApartment();
    const res = await providerDb.execute<{ status: string }>(
      sql`INSERT INTO discovery_records (org_id, apartment_id, created_by)
          VALUES (${testOrgId}, ${aptId}, ${creatorId})
          RETURNING status`,
    );
    expect(res.rows[0]!.status).toBe('not_visited');
  }, 30_000);

  // ===========================================================================
  // TEST #4 — apartment-cascade: deleting the apartment removes the record
  // ===========================================================================
  it('4) cascades on apartment delete (FK apartment_id ON DELETE CASCADE)', async () => {
    const aptId = await seedApartment();
    await providerDb.execute(
      sql`INSERT INTO discovery_records (org_id, apartment_id, created_by)
          VALUES (${testOrgId}, ${aptId}, ${creatorId})`,
    );
    // Hard-delete the apartment via BYPASSRLS — the discovery record must vanish.
    await providerDb.execute(sql`DELETE FROM apartments WHERE id = ${aptId}`);
    const after = await providerDb.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM discovery_records WHERE apartment_id = ${aptId}`,
    );
    expect(Number(after.rows[0]!.n)).toBe(0);
  }, 30_000);

  // ===========================================================================
  // TEST #5 — STRUCTURAL: an occupant/discovery-source is NEVER a signature
  //            recipient. A discovery record is NOT in owners/ownerships, so it
  //            has no owner row to target as a recipient.
  // ===========================================================================
  it('5) a discovery-source occupant has NO owner/ownership row — can never be a signature recipient', async () => {
    // SPEC §2: a recipient ∈ { owner , contractor }. An occupant lives ONLY in
    // discovery_records. The structural guarantee: a discovery record carries NO
    // owner_id and creates NO ownership row, so the signatures recipient path
    // (which resolves owner_id → owners/ownerships) can never select it.
    const aptId = await seedApartment();
    const drRes = await providerDb.execute<{ id: string }>(
      sql`INSERT INTO discovery_records (org_id, apartment_id, status, notes, created_by)
          VALUES (${testOrgId}, ${aptId}, 'spoke_to_occupant', ${'occupant only'}, ${creatorId})
          RETURNING id`,
    );
    const discoveryId = drRes.rows[0]!.id;

    // (a) The discovery_records table has NO owner_id column at all — there is
    //     no FK into owners, by design. (information_schema is authoritative.)
    const cols = await providerDb.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_name = 'discovery_records' AND column_name = 'owner_id'`,
    );
    expect(cols.rows).toHaveLength(0);

    // (b) This apartment has NO ownership row at all (no owner, no renter) — the
    //     occupant was recorded purely as a discovery source. The signatures
    //     recipient resolution (resolveAssociatedOwners / resolveRenterOnly in
    //     signature-requests.service.ts) joins ownerships → owners; with zero
    //     ownership rows there is nothing it could ever resolve for this apt.
    const ownRows = await providerDb.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ownerships WHERE apartment_id = ${aptId}`,
    );
    expect(Number(ownRows.rows[0]!.n)).toBe(0);

    // (c) The discovery record id is NOT an owner id — it cannot be passed as an
    //     ownerId to the signature path (no owners row has this id).
    const asOwner = await providerDb
      .select({ id: owners.id })
      .from(owners)
      .where(eq(owners.id, discoveryId))
      .catch(() => []);
    expect(asOwner).toHaveLength(0);
  }, 30_000);

  // ===========================================================================
  // TEST #6 — MIGRATION BEHAVIOR: an apartment that HAD a relationship='renter'
  //            ownership row, after the migration, has NO renter ownership row
  //            and HAS a discovery_records row (status 'spoke_to_occupant').
  //
  // NOTE ON EXPRESSIBILITY (documented gap): the renter→discovery DATA MIGRATION
  // runs ONCE at migrate() time, BEFORE any test seeds data — it can only move
  // renter rows that already existed when the migration ran. A renter row this
  // test seeds NOW (post-migration) is NOT retroactively converted. So this test
  // asserts the INVARIANT the migration must establish + maintain, in a way that
  // is meaningful both pre- and post-fix:
  //   (i)  CURRENTLY (RED): discovery_records is missing → 42P01 (the table-
  //        missing gap, same as #1).
  //   (ii) AFTER the fix: the table exists AND the CHECK lets 'spoke_to_occupant'
  //        in. The full data-migration (renter rows → discovery + DELETE) is
  //        additionally asserted as a global post-migration invariant in #7.
  // ===========================================================================
  it("6) the renter→discovery mapping target (status 'spoke_to_occupant') is a valid discovery record on the apartment", async () => {
    const aptId = await seedApartment();
    // Model what the migration produces for a former renter: a discovery record
    // with status 'spoke_to_occupant' on the renter's apartment.
    const res = await providerDb.execute<{ id: string; status: string }>(
      sql`INSERT INTO discovery_records (org_id, apartment_id, status, created_by)
          VALUES (${testOrgId}, ${aptId}, 'spoke_to_occupant', ${creatorId})
          RETURNING id, status`,
    );
    expect(res.rows[0]!.status).toBe('spoke_to_occupant');

    // And the apartment carries NO renter ownership row (the migration DELETEs
    // them; here we never created one — the post-state the builder must reach).
    const renterRows = await providerDb.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ownerships
          WHERE apartment_id = ${aptId} AND relationship = 'renter'`,
    );
    expect(Number(renterRows.rows[0]!.n)).toBe(0);
  }, 30_000);

  // ===========================================================================
  // TEST #7 — GLOBAL POST-MIGRATION INVARIANT: NO active renter ownership rows
  //            remain anywhere (the migration converted+deleted them all). Every
  //            occupant now lives in discovery_records, never in ownerships.
  // ===========================================================================
  it('7) POST-MIGRATION INVARIANT: no active renter ownership rows remain (occupants moved to discovery_records)', async () => {
    // After the renter→discovery migration, `relationship='renter'` must no
    // longer appear among active ownerships — occupants are discovery sources,
    // not ownership rows. (RED now in two ways: discovery_records is missing,
    // AND legacy renter rows from owner-renter.spec seeds may still be present
    // until the migration sweeps them. The builder's migration makes this 0.)
    //
    // We assert this against discovery_records existence too, so the test is a
    // single coherent "the migration ran" signal.
    const tableExists = await providerDb.execute<{ exists: boolean }>(
      sql`SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'discovery_records'
          ) AS exists`,
    );
    // The table MUST exist post-fix. RED now: this is false.
    expect(tableExists.rows[0]!.exists).toBe(true);

    const renterRows = await providerDb.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ownerships
          WHERE ended_at IS NULL AND relationship = 'renter'`,
    );
    expect(Number(renterRows.rows[0]!.n)).toBe(0);
  }, 30_000);

  // ===========================================================================
  // TEST #8 — RLS: a discovery record is tenant-isolated via the apartment→
  //            building→project→org chain (Template B, like building_sections).
  // ===========================================================================
  it('8) RLS-scopes discovery records via apartment→building→project→org (cross-org cannot read)', async () => {
    const aptId = await seedApartment();
    await providerDb.execute(
      sql`INSERT INTO discovery_records (org_id, apartment_id, status, created_by)
          VALUES (${testOrgId}, ${aptId}, 'owner_identified', ${creatorId})`,
    );

    // Read under app_user with a DIFFERENT org's GUC — RLS must hide the row.
    const otherOrg = randomUUID();
    const client = await providerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', otherOrg],
      });
      const foreign = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM discovery_records WHERE apartment_id = $1`,
        [aptId],
      );
      // Foreign org sees ZERO — tenant isolation holds.
      expect(Number(foreign.rows[0]!.n)).toBe(0);

      // Sanity: the SAME org's GUC DOES see it (the row really is there).
      await client.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', testOrgId],
      });
      const own = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM discovery_records WHERE apartment_id = $1`,
        [aptId],
      );
      expect(Number(own.rows[0]!.n)).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }, 30_000);
});
