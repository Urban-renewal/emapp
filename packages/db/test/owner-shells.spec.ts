/**
 * Owner SHELLS — S3a acceptance tests (TEST-AUTHOR, independent, RED-first).
 *
 * SPEC ("owner shells"): an owner can be created as a SKELETON with NO name
 * and NO national_id — a field worker / Tabu import enriches the record later.
 *
 * These tests are written from the SPEC, BEFORE the builder relaxes the
 * constraints. They are expected to be RED against the CURRENT schema:
 *   - `owners.name_encrypted` is NOT NULL (packages/db/src/schema/projects.ts:211)
 *   - `owners.national_id_encrypted` is NOT NULL (…:219)
 * so a shell insert (both NULL) is rejected with a 23502 not-null violation.
 * They go GREEN once the builder drops those NOT NULL constraints.
 *
 * Level: DB-level integration (insert via the `owners` table + the real
 * pgcrypto helpers), mirroring owner-name-encryption.spec.ts. This isolates
 * the SPEC's claims to the SCHEMA constraints (NOT NULL + the per-org
 * national_id unique index) without dragging in the API auth/DTO layer.
 *
 * DO NOT modify any implementation/schema file to make these pass — that is
 * the builder's job. This file only asserts the target behavior.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  decryptOwnerName,
  encryptOwnerName,
  encryptOwnerPii,
  hashField,
  organizations,
  owners,
  providerDb,
  env as dbEnv,
} from '@emapp/db';

const TEST_ORG_NAME = 's3a-owner-shells';
let testOrgId: string;

async function ensureOrg(): Promise<string> {
  const id = randomUUID();
  await providerDb.insert(organizations).values({
    id,
    name: `${TEST_ORG_NAME}-${id.slice(0, 8)}`,
    slug: `shell${id.slice(0, 8)}`,
  });
  return id;
}

async function dropOrgRows(orgId: string): Promise<void> {
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

describe('owner shells (S3a — skeleton owners, no name / no national_id)', () => {
  beforeAll(async () => {
    testOrgId = await ensureOrg();
  });
  afterEach(async () => {
    // Each test seeds its own owners; clear between tests so the per-org
    // unique-index assertions don't interfere with one another.
    await providerDb
      .delete(owners)
      .where(eq(owners.orgId, testOrgId))
      .catch(() => undefined);
  });
  afterAll(async () => {
    await dropOrgRows(testOrgId);
  });

  // ---- TEST #1: shell create — RED NOW (proves the NOT NULL gap) ----------
  it('1) creates a SHELL owner with NO name AND NO national_id (returns a valid row)', async () => {
    // The SPEC: a skeleton owner. name_encrypted + national_id_encrypted are
    // intentionally absent. Today both columns are NOT NULL, so this INSERT
    // fails with 23502 — that failure IS the gap this test documents.
    const inserted = await providerDb
      .insert(owners)
      .values({
        orgId: testOrgId,
        // no nameEncrypted / nameHash
        // no nationalIdEncrypted / nationalIdHash
        // no phone, no email — a pure skeleton
      })
      .returning({ id: owners.id });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.id).toBeTruthy();

    // The row reads back as a genuine, query-able owner row.
    const [back] = await providerDb
      .select({
        id: owners.id,
        nameEncrypted: owners.nameEncrypted,
        nationalIdEncrypted: owners.nationalIdEncrypted,
      })
      .from(owners)
      .where(eq(owners.id, inserted[0]!.id))
      .limit(1);
    expect(back).toBeTruthy();
    expect(back?.nameEncrypted).toBeNull();
    expect(back?.nationalIdEncrypted).toBeNull();
  });

  // ---- TEST #2: two shells in the SAME org do NOT collide -----------------
  it('2) allows MULTIPLE shell owners (no national_id) in the same org — NULLs are distinct', async () => {
    // Postgres treats NULLs as distinct in a unique index, so two no-national_id
    // owners must NOT collide on owners_org_natid_unique_active. (Should already
    // hold at the DB level; asserted so the builder cannot regress it.)
    const a = await providerDb
      .insert(owners)
      .values({ orgId: testOrgId })
      .returning({ id: owners.id });
    const b = await providerDb
      .insert(owners)
      .values({ orgId: testOrgId })
      .returning({ id: owners.id });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);

    const rows = await providerDb
      .select({ id: owners.id })
      .from(owners)
      .where(and(eq(owners.orgId, testOrgId), isNull(owners.archivedAt)));
    expect(rows.length).toBe(2);
  });

  // ---- TEST #3: regression guard — national_id still unique-per-org -------
  it('3) STILL enforces unique national_id per org for non-shell owners', async () => {
    const hashKey = dbEnv.PII_HASH_KEY as string;
    const nationalId = '038111119';
    const pii = await encryptOwnerPii(providerDb, { nationalId, name: 'נון-של ראשון' });

    await providerDb.insert(owners).values({
      orgId: testOrgId,
      nameEncrypted: pii.nameEncrypted,
      nameHash: pii.nameHash,
      nationalIdEncrypted: pii.nationalIdEncrypted,
      nationalIdHash: pii.nationalIdHash,
    });

    // A SECOND active owner with the SAME national_id in the SAME org must be
    // rejected by owners_org_natid_unique_active (SQLSTATE 23505). The hash is
    // what the unique index keys on; reuse it verbatim. Drizzle wraps the pg
    // error in a DrizzleQueryError, so the SQLSTATE lives on `.cause.code` and
    // the constraint name on `.cause.constraint`.
    const pii2 = await encryptOwnerPii(providerDb, { nationalId, name: 'נון-של שני' });
    const err = await providerDb
      .insert(owners)
      .values({
        orgId: testOrgId,
        nameEncrypted: pii2.nameEncrypted,
        nameHash: pii2.nameHash,
        nationalIdEncrypted: pii2.nationalIdEncrypted,
        // SAME hash → same unique-index key as the first row.
        nationalIdHash: hashField(nationalId, hashKey),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeTruthy();
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint).toBe('owners_org_natid_unique_active');
  });

  // ---- TEST #4: read/list a shell (no name) does not crash ----------------
  it('4) reads/lists a SHELL owner (no name) without crashing — NULL name handled gracefully', async () => {
    // A shell with a name (so we have a non-null to decrypt) + a pure shell
    // (NULL name). The read path (a plain SELECT over the org) must return both
    // rows and not throw on the NULL-name shell.
    const named = await encryptOwnerName(providerDb, 'יש שם');
    await providerDb.insert(owners).values({
      orgId: testOrgId,
      nameEncrypted: named.nameEncrypted,
      nameHash: named.nameHash,
    });
    const shellId = (
      await providerDb.insert(owners).values({ orgId: testOrgId }).returning({ id: owners.id })
    )[0]!.id;

    const rows = await providerDb
      .select({ id: owners.id, nameEncrypted: owners.nameEncrypted })
      .from(owners)
      .where(eq(owners.orgId, testOrgId))
      .orderBy(owners.createdAt);
    expect(rows.length).toBe(2);

    // The NULL-name shell is present and its name_encrypted is NULL (the read
    // path must tolerate this — no decrypt attempt on a NULL).
    const shellRow = rows.find((r) => r.id === shellId);
    expect(shellRow).toBeTruthy();
    expect(shellRow?.nameEncrypted).toBeNull();

    // The named owner still decrypts cleanly (the named path is unaffected).
    const namedRow = rows.find((r) => r.id !== shellId);
    expect(namedRow?.nameEncrypted).toBeTruthy();
    expect(await decryptOwnerName(providerDb, namedRow!.nameEncrypted!)).toBe('יש שם');
  });
});
