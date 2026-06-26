/**
 * DOCUMENT TAXONOMY SCOPE — DH1 acceptance tests (migration 0077).
 *
 * SPEC (docs/MASTER-PLAN-V13.md Wave B DH1): the `documents` spine grows a
 * CLOSED, TYPED scope link so a doc hangs off exactly one of org | project |
 * apartment | owner, plus an explicit owner FK. Schema additions:
 *   - doc_scope     doc_scope NOT NULL DEFAULT 'org' (enum org|project|apartment|owner)
 *   - doc_scope_id  uuid NULL — the typed scope target id (NULL iff scope='org')
 *   - owner_id      uuid NULL, FK → owners ON DELETE SET NULL
 *   - CHECK documents_doc_scope_id_consistent: org ⇒ scope_id NULL; non-org ⇒
 *     scope_id NOT NULL
 *   - BACKFILL existing rows: apartment_id ⇒ scope='apartment',scope_id=apartment_id;
 *     else project_id ⇒ scope='project',scope_id=project_id; else scope='org'.
 * The legacy project_id/apartment_id columns are KEPT for back-compat.
 *
 * These tests prove the migration applied cleanly AND the backfill derivation is
 * correct. The renter→discovery spec is the structural template (providerDb /
 * raw SQL, BYPASSRLS seeding). The backfill is a one-time migrate()-time pass,
 * so this test MODELS legacy rows (project_id/apartment_id set, doc_scope left at
 * its DEFAULT 'org'), runs the SAME backfill SQL the migration runs, and asserts
 * the derived (scope, scope_id) — meaningful regardless of pre-existing data.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=... infisical run --env dev -- \
 *     pnpm --filter @emapp/db exec vitest run test/document-taxonomy-scope.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const TEST_ORG_NAME = 'dh1-doc-taxonomy';

let testOrgId: string;
let creatorId: string;
let projectId: string;

/** Minimal scope chain: org + manager user + membership + one project. */
async function seedOrgScaffold(): Promise<void> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `${TEST_ORG_NAME}-${orgId.slice(0, 8)}`,
    slug: `dh1${orgId.slice(0, 8)}`,
  });
  testOrgId = orgId;

  const [mgr] = await providerDb
    .insert(users)
    .values({
      email: `dh1-mgr-${orgId.slice(0, 8)}@test.local`,
      name: 'DH1 Manager',
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

/** A fresh apartment (new building) per call — isolation. Returns apt id. */
async function seedApartment(): Promise<string> {
  const [bld] = await providerDb
    .insert(buildings)
    .values({
      projectId,
      address: `DH1 ${Date.now()}-${Math.random()}`,
      city: 'Tel Aviv',
    })
    .returning({ id: buildings.id });
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId: bld!.id, number: `A-${Date.now()}-${Math.random()}` })
    .returning({ id: apartments.id });
  return apt!.id;
}

/** A minimal owner SHELL (no PII required) in the test org. Returns owner id. */
async function seedOwner(): Promise<string> {
  const [o] = await providerDb
    .insert(owners)
    .values({ orgId: testOrgId })
    .returning({ id: owners.id });
  return o!.id;
}

/**
 * Insert a document row mimicking the LEGACY shape (pre-0077): only the columns
 * the old code/seeders set, leaving doc_scope at its column DEFAULT and
 * doc_scope_id/owner_id unset. Returns the new doc id. Uses raw SQL (BYPASSRLS
 * providerDb) so RLS doesn't obstruct the cross-cutting seed.
 */
async function seedLegacyDoc(opts: {
  projectId?: string | null;
  apartmentId?: string | null;
}): Promise<string> {
  const r = await providerDb.execute<{ id: string }>(sql`
    INSERT INTO documents
      (org_id, project_id, apartment_id, name, type, mime_type, size_bytes,
       r2_key, content_hash, uploaded_by)
    VALUES
      (${testOrgId}, ${opts.projectId ?? null}, ${opts.apartmentId ?? null},
       'legacy.pdf', 'other', 'application/pdf', 100,
       ${`org/${testOrgId}/doc/${randomUUID()}`}, 'h', ${creatorId})
    RETURNING id
  `);
  return r.rows[0]!.id;
}

/** Run the EXACT backfill the 0077 migration runs (idempotent, set-based),
 *  scoped to this test's org so it only touches the rows we just seeded. */
async function runBackfill(): Promise<void> {
  await providerDb.execute(sql`
    UPDATE documents SET doc_scope = 'apartment', doc_scope_id = apartment_id
     WHERE org_id = ${testOrgId} AND apartment_id IS NOT NULL
  `);
  await providerDb.execute(sql`
    UPDATE documents SET doc_scope = 'project', doc_scope_id = project_id
     WHERE org_id = ${testOrgId} AND apartment_id IS NULL AND project_id IS NOT NULL
  `);
}

async function readScope(
  id: string,
): Promise<{ doc_scope: string; doc_scope_id: string | null; owner_id: string | null }> {
  const r = await providerDb.execute<{
    doc_scope: string;
    doc_scope_id: string | null;
    owner_id: string | null;
  }>(sql`SELECT doc_scope, doc_scope_id, owner_id FROM documents WHERE id = ${id} LIMIT 1`);
  return r.rows[0]!;
}

async function cleanup(): Promise<void> {
  await providerDb
    .execute(sql`DELETE FROM documents WHERE org_id = ${testOrgId}`)
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

describe('documents taxonomy scope (DH1 / migration 0077)', () => {
  // ── schema presence ──────────────────────────────────────────────────────
  it('1) adds doc_scope (enum, NOT NULL DEFAULT org), doc_scope_id (uuid null), owner_id (uuid null)', async () => {
    const cols = await providerDb.execute<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'documents'
        AND column_name IN ('doc_scope', 'doc_scope_id', 'owner_id')
      ORDER BY column_name
    `);
    const by = Object.fromEntries(cols.rows.map((c) => [c.column_name, c]));
    expect(by.doc_scope).toBeDefined();
    expect(by.doc_scope!.udt_name).toBe('doc_scope'); // the enum type
    expect(by.doc_scope!.is_nullable).toBe('NO');
    expect(by.doc_scope!.column_default).toContain('org');
    expect(by.doc_scope_id).toBeDefined();
    expect(by.doc_scope_id!.data_type).toBe('uuid');
    expect(by.doc_scope_id!.is_nullable).toBe('YES');
    expect(by.owner_id).toBeDefined();
    expect(by.owner_id!.data_type).toBe('uuid');
    expect(by.owner_id!.is_nullable).toBe('YES');
  }, 30_000);

  it('2) doc_scope enum is exactly org|project|apartment|owner', async () => {
    const r = await providerDb.execute<{ enumlabel: string }>(sql`
      SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'doc_scope' ORDER BY e.enumsortorder
    `);
    expect(r.rows.map((x) => x.enumlabel)).toEqual(['org', 'project', 'apartment', 'owner']);
  }, 30_000);

  // ── backfill derivation correctness (the core gate) ──────────────────────
  it('3) BACKFILL: apartment_id present ⇒ scope=apartment, scope_id=apartment_id', async () => {
    const aptId = await seedApartment();
    // Apartment-scoped doc (project_id NULL — the apartment is the canonical
    // parent per 0083 documents_parent_exclusive; it resolves the project via
    // its building). Backfill must still derive scope=apartment.
    const docId = await seedLegacyDoc({ projectId: null, apartmentId: aptId });
    // Legacy state before backfill: default scope 'org', no scope_id.
    const before = await readScope(docId);
    expect(before.doc_scope).toBe('org');
    expect(before.doc_scope_id).toBeNull();

    await runBackfill();

    const after = await readScope(docId);
    expect(after.doc_scope).toBe('apartment');
    expect(after.doc_scope_id).toBe(aptId);
  }, 30_000);

  it('4) BACKFILL: project_id only (no apartment) ⇒ scope=project, scope_id=project_id', async () => {
    const docId = await seedLegacyDoc({ projectId, apartmentId: null });
    await runBackfill();
    const after = await readScope(docId);
    expect(after.doc_scope).toBe('project');
    expect(after.doc_scope_id).toBe(projectId);
  }, 30_000);

  it('5) BACKFILL: neither present ⇒ scope=org, scope_id=NULL (untouched default)', async () => {
    const docId = await seedLegacyDoc({ projectId: null, apartmentId: null });
    await runBackfill();
    const after = await readScope(docId);
    expect(after.doc_scope).toBe('org');
    expect(after.doc_scope_id).toBeNull();
  }, 30_000);

  // ── CHECK enforcement ────────────────────────────────────────────────────
  it('6) CHECK rejects a non-org scope with NULL scope_id (23514)', async () => {
    const err = await providerDb
      .execute(
        sql`INSERT INTO documents
              (org_id, name, type, mime_type, size_bytes, r2_key, content_hash,
               uploaded_by, doc_scope, doc_scope_id)
            VALUES (${testOrgId}, 'bad.pdf', 'other', 'application/pdf', 1,
                    ${`org/${testOrgId}/doc/${randomUUID()}`}, 'h', ${creatorId},
                    'project', NULL)`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeTruthy();
    const code =
      (err as { cause?: { code?: string }; code?: string }).cause?.code ??
      (err as { code?: string }).code;
    expect(code).toBe('23514');
  }, 30_000);

  it('7) CHECK rejects an org scope WITH a non-NULL scope_id (23514)', async () => {
    const err = await providerDb
      .execute(
        sql`INSERT INTO documents
              (org_id, name, type, mime_type, size_bytes, r2_key, content_hash,
               uploaded_by, doc_scope, doc_scope_id)
            VALUES (${testOrgId}, 'bad2.pdf', 'other', 'application/pdf', 1,
                    ${`org/${testOrgId}/doc/${randomUUID()}`}, 'h', ${creatorId},
                    'org', ${randomUUID()})`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeTruthy();
    const code =
      (err as { cause?: { code?: string }; code?: string }).cause?.code ??
      (err as { code?: string }).code;
    expect(code).toBe('23514');
  }, 30_000);

  it('8) CHECK accepts a valid owner-scoped row (scope=owner + scope_id present)', async () => {
    const ownerId = await seedOwner();
    const r = await providerDb.execute<{ id: string; doc_scope: string }>(
      sql`INSERT INTO documents
            (org_id, name, type, mime_type, size_bytes, r2_key, content_hash,
             uploaded_by, doc_scope, doc_scope_id, owner_id)
          VALUES (${testOrgId}, 'owner.pdf', 'land_registry', 'application/pdf', 1,
                  ${`org/${testOrgId}/doc/${randomUUID()}`}, 'h', ${creatorId},
                  'owner', ${ownerId}, ${ownerId})
          RETURNING id, doc_scope`,
    );
    expect(r.rows[0]!.doc_scope).toBe('owner');
  }, 30_000);

  // ── owner FK ON DELETE SET NULL ──────────────────────────────────────────
  it('9) owner_id FK is ON DELETE SET NULL — erasing the owner de-links, never blocks/destroys the doc', async () => {
    const ownerId = await seedOwner();
    // owner-scoped via doc_scope_id too; deleting the owner must SET NULL the
    // owner_id but the row (and its scope) must survive.
    const r = await providerDb.execute<{ id: string }>(
      sql`INSERT INTO documents
            (org_id, name, type, mime_type, size_bytes, r2_key, content_hash,
             uploaded_by, owner_id)
          VALUES (${testOrgId}, 'fk.pdf', 'other', 'application/pdf', 1,
                  ${`org/${testOrgId}/doc/${randomUUID()}`}, 'h', ${creatorId}, ${ownerId})
          RETURNING id`,
    );
    const docId = r.rows[0]!.id;

    // Hard-delete the owner (BYPASSRLS). Must NOT throw (no RESTRICT) and must
    // NOT cascade-delete the document.
    await providerDb.execute(sql`DELETE FROM owners WHERE id = ${ownerId}`);

    const after = await readScope(docId);
    expect(after).toBeDefined(); // the doc still exists
    expect(after.owner_id).toBeNull(); // de-linked
  }, 30_000);

  it('10) backfill is idempotent — re-running derives the identical (scope, scope_id)', async () => {
    const aptId = await seedApartment();
    const docId = await seedLegacyDoc({ projectId: null, apartmentId: aptId });
    await runBackfill();
    const first = await readScope(docId);
    await runBackfill(); // re-run
    const second = await readScope(docId);
    expect(second).toEqual(first);
    expect(second.doc_scope).toBe('apartment');
    expect(second.doc_scope_id).toBe(aptId);
  }, 30_000);
});
