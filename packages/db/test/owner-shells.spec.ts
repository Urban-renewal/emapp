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

import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  buildErasureTombstone,
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

  // ---- TEST #5: DSAR subject-access EXPORT on a SHELL is null-safe ---------
  it('5) DSAR export decrypt projection on a SHELL returns name=null + nationalId=null WITHOUT throwing', async () => {
    // Regression guard for the HIGH a DSAR-on-shell test would have caught:
    // before the fix, data-subject.service.ts decrypted national_id/name with a
    // BARE pgp_sym_decrypt(<col>, key) and the export schema was non-nullable.
    // On a SHELL owner (NULL name + NULL national_id ciphertext) pgp_sym_decrypt
    // on NULL yields NULL — fine — but the contract said non-null. The fix wraps
    // each decrypt in `case when <col> is null then null else pgp_sym_decrypt(...)
    // end` AND makes the export schema nullable. This test exercises the EXACT
    // null-guarded SQL the export now runs (NID_CLEAR / NAME_CLEAR) and asserts
    // it returns NULL for both — proving the DSAR-on-shell path is null-safe and
    // the nullable contract holds.
    //
    // Fidelity note: the service runs this inside withTenant, which binds the
    // decrypt key to the `app.encryption_key` GUC via SET LOCAL. We reproduce
    // that EXACTLY: a transaction that `set_config('app.encryption_key', <key>,
    // true)` then runs the same `current_setting('app.encryption_key')`-bound
    // CASE expression against the shell row — byte-for-byte what dataExport emits.
    const shellId = (
      await providerDb.insert(owners).values({ orgId: testOrgId }).returning({ id: owners.id })
    )[0]!.id;

    const encKey = dbEnv.PII_ENCRYPTION_KEY as string;
    const projected = await providerDb.transaction(async (tx) => {
      // SET LOCAL the encryption key onto the GUC the export's SQL reads from —
      // identical to withTenant's posture (third arg `true` = tx-local).
      await tx.execute(sql`SELECT set_config('app.encryption_key', ${encKey}, true)`);
      // The EXACT null-guarded decrypt projection from data-subject.service.ts
      // (NID_CLEAR / NAME_CLEAR): NULL ciphertext → NULL, else GUC-bound decrypt.
      const res = await tx.execute<{ name: string | null; national_id: string | null }>(sql`
        SELECT
          case when ${owners.nameEncrypted} is null then null
               else pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text end AS name,
          case when ${owners.nationalIdEncrypted} is null then null
               else pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text end AS national_id
        FROM ${owners}
        WHERE ${owners.id} = ${shellId}
        LIMIT 1
      `);
      return res.rows[0];
    });

    // The reveal projection did NOT throw, and both PII fields decrypted to NULL
    // (not a pgcrypto error, not the empty string) — the nullable export contract.
    expect(projected).toBeTruthy();
    expect(projected?.name).toBeNull();
    expect(projected?.national_id).toBeNull();
  });

  // ---- TEST #6: ERASURE on a SHELL succeeds (no throw on already-NULL PII) -
  it('6) erasure tombstone overwrite on a SHELL succeeds and leaves the row erased', async () => {
    // A shell owner already has NULL name/national_id ciphertext + NULL hashes.
    // The erase path overwrites the encrypted PII columns with the irreversible
    // buildErasureTombstone ciphertexts and stamps erased_at — it must NOT choke
    // on the already-NULL PII (no "decrypt of null" / not-null-violation surprise).
    const shellId = (
      await providerDb.insert(owners).values({ orgId: testOrgId }).returning({ id: owners.id })
    )[0]!.id;

    // Build the tombstone ciphertexts exactly as DataSubjectService.erase does.
    const tombstone = await buildErasureTombstone(providerDb);
    const now = new Date();

    // The tombstone overwrite + erasure stamp. On a shell this writes ciphertext
    // INTO previously-NULL columns and NULLs the (already-NULL) hashes — must not
    // throw. Mirrors the service's `update(owners).set({...})`.
    await providerDb
      .update(owners)
      .set({
        nameEncrypted: tombstone.nameEncrypted,
        nationalIdEncrypted: tombstone.nationalIdEncrypted,
        phoneEncrypted: tombstone.phoneEncrypted,
        nameHash: null,
        nationalIdHash: null,
        phoneHash: null,
        email: null,
        notes: null,
        erasedAt: now,
        archivedAt: now,
        updatedAt: now,
      })
      .where(eq(owners.id, shellId));

    // The row ends erased: erased_at is set + the PII columns hold the tombstone
    // ciphertext (NOT NULL anymore, NOT the original — there never was any).
    const [erased] = await providerDb
      .select({
        id: owners.id,
        erasedAt: owners.erasedAt,
        archivedAt: owners.archivedAt,
        nameEncrypted: owners.nameEncrypted,
        nationalIdEncrypted: owners.nationalIdEncrypted,
      })
      .from(owners)
      .where(eq(owners.id, shellId))
      .limit(1);
    expect(erased).toBeTruthy();
    expect(erased?.erasedAt).not.toBeNull();
    expect(erased?.archivedAt).not.toBeNull();
    expect(erased?.nameEncrypted).not.toBeNull();
    expect(erased?.nationalIdEncrypted).not.toBeNull();
    // And the tombstone is irreversible-to-the-marker: it decrypts to "[erased]",
    // never to any subject PII (a shell never had any).
    expect(await decryptOwnerName(providerDb, erased!.nameEncrypted!)).toBe('[erased]');
  });

  // ---- TEST #7: reveal on a SHELL returns null national_id gracefully ------
  it('7) reveal (cleartext national_id) on a SHELL returns null without throwing', async () => {
    // The masked/reveal read path on a shell: the national_id ciphertext is NULL,
    // so the null-guarded decrypt must yield NULL rather than erroring. Same
    // CASE-guard contract as the DSAR export, asserted on the reveal projection.
    const shellId = (
      await providerDb.insert(owners).values({ orgId: testOrgId }).returning({ id: owners.id })
    )[0]!.id;

    const encKey = dbEnv.PII_ENCRYPTION_KEY as string;
    const revealed = await providerDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.encryption_key', ${encKey}, true)`);
      const res = await tx.execute<{ national_id: string | null }>(sql`
        SELECT
          case when ${owners.nationalIdEncrypted} is null then null
               else pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text end AS national_id
        FROM ${owners}
        WHERE ${owners.id} = ${shellId}
        LIMIT 1
      `);
      return res.rows[0];
    });

    expect(revealed).toBeTruthy();
    expect(revealed?.national_id).toBeNull();
  });
});
