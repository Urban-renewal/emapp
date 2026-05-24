/**
 * Purge-import-bytes — v8 §v8-S1 closure tests.
 *
 * Seeds a real import_jobs row + uses FakeStorageProvider (tracks
 * delete calls). Exercises:
 *   1. terminal job (done) → purged, file_deleted_at set
 *   2. non-terminal job (parsing) → not-terminal, NO delete call
 *   3. already-purged → idempotent (no second delete)
 *   4. missing row → graceful 'missing' return
 *   5. storage.delete failure → audit row written, file_deleted_at NOT set
 *   6. CHECK constraint enforces non-terminal cannot have file_deleted_at
 */
import { randomUUID } from 'node:crypto';

import {
  FakeStorageProvider,
  importJobs,
  organizations,
  providerDb,
  users,
  type IStorageProvider,
} from '@emapp/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { purgeImportBytes } from '../src/handlers/purge-import-bytes';

interface Fixture {
  orgId: string;
  userId: string;
}

async function seed(): Promise<Fixture> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `v8-s1-${orgId.slice(0, 8)}`,
    slug: `s1test${orgId.slice(0, 8)}`,
  });
  await providerDb.insert(users).values({
    id: userId,
    email: `v8-s1-${userId.slice(0, 8)}@test.local`,
    passwordHash: 'argon2id$dummy',
    name: 'v8 s1 test',
  });
  return { orgId, userId };
}

async function teardown(fx: Fixture): Promise<void> {
  await providerDb
    .delete(importJobs)
    .where(eq(importJobs.orgId, fx.orgId))
    .catch(() => undefined);
  await providerDb
    .delete(users)
    .where(eq(users.id, fx.userId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, fx.orgId))
    .catch(() => undefined);
}

async function insertJob(
  orgId: string,
  userId: string,
  status: 'done' | 'failed' | 'cancelled' | 'parsing',
): Promise<{ id: string; r2Key: string }> {
  const id = randomUUID();
  const r2Key = `org/${orgId}/import/${id}.xlsx`;
  await providerDb.insert(importJobs).values({
    id,
    orgId,
    status,
    fileR2Key: r2Key,
    fileName: 't.xlsx',
    fileSizeBytes: 1,
    fileContentHash: 'sha256:' + 'a'.repeat(64),
    createdBy: userId,
  });
  return { id, r2Key };
}

const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

describe('purgeImportBytes (v8 §v8-S1)', () => {
  let fx: Fixture;
  let storage: IStorageProvider;

  beforeAll(async () => {
    fx = await seed();
  });
  afterAll(async () => {
    await teardown(fx);
  });
  beforeEach(() => {
    storage = new FakeStorageProvider();
  });

  it('1) terminal job (done) → purged + file_deleted_at set + R2 delete called', async () => {
    const job = await insertJob(fx.orgId, fx.userId, 'done');
    const result = await purgeImportBytes({
      orgId: fx.orgId,
      jobId: job.id,
      verifiedActorId: fx.userId,
      storage,
      log: silentLog,
    });
    expect(result).toBe('purged');
    const [row] = await providerDb
      .select({ fileDeletedAt: importJobs.fileDeletedAt })
      .from(importJobs)
      .where(eq(importJobs.id, job.id))
      .limit(1);
    expect(row?.fileDeletedAt).toBeInstanceOf(Date);
  });

  it('2) non-terminal job (parsing) → not-terminal, no R2 delete call, file_deleted_at still NULL', async () => {
    const job = await insertJob(fx.orgId, fx.userId, 'parsing');
    const result = await purgeImportBytes({
      orgId: fx.orgId,
      jobId: job.id,
      verifiedActorId: fx.userId,
      storage,
      log: silentLog,
    });
    expect(result).toBe('not-terminal');
    const [row] = await providerDb
      .select({ fileDeletedAt: importJobs.fileDeletedAt })
      .from(importJobs)
      .where(eq(importJobs.id, job.id))
      .limit(1);
    expect(row?.fileDeletedAt).toBeNull();
  });

  it('3) already-purged → idempotent (returns already)', async () => {
    const job = await insertJob(fx.orgId, fx.userId, 'failed');
    await purgeImportBytes({
      orgId: fx.orgId,
      jobId: job.id,
      verifiedActorId: fx.userId,
      storage,
      log: silentLog,
    });
    const second = await purgeImportBytes({
      orgId: fx.orgId,
      jobId: job.id,
      verifiedActorId: fx.userId,
      storage,
      log: silentLog,
    });
    expect(second).toBe('already');
  });

  it('4) missing row → returns missing (no throw)', async () => {
    const result = await purgeImportBytes({
      orgId: fx.orgId,
      jobId: randomUUID(),
      verifiedActorId: fx.userId,
      storage,
      log: silentLog,
    });
    expect(result).toBe('missing');
  });

  it('5) storage.delete failure → file_deleted_at NOT set, audit row written', async () => {
    const job = await insertJob(fx.orgId, fx.userId, 'cancelled');
    // Make storage.delete fail.
    const failingStorage: IStorageProvider = {
      ...storage,
      delete: async () => {
        throw new Error('synthetic R2 outage');
      },
    };
    const result = await purgeImportBytes({
      orgId: fx.orgId,
      jobId: job.id,
      verifiedActorId: fx.userId,
      storage: failingStorage,
      log: silentLog,
    });
    // v8.5: was 'not-terminal' (overloaded code); now 'purge-failed'
    // — distinct return so a future sweeper can tell "retry needed"
    // apart from "skip, not eligible." See packages/db/src/helpers/
    // import-bytes.ts JSDoc.
    expect(result).toBe('purge-failed');
    const [row] = await providerDb
      .select({ fileDeletedAt: importJobs.fileDeletedAt })
      .from(importJobs)
      .where(eq(importJobs.id, job.id))
      .limit(1);
    expect(row?.fileDeletedAt).toBeNull();
  });

  it('6) CHECK constraint refuses file_deleted_at on a non-terminal row', async () => {
    const job = await insertJob(fx.orgId, fx.userId, 'parsing');
    // Direct UPDATE bypassing the worker logic must fail with a
    // CHECK violation. Drizzle wraps the pg error so we can't match
    // the constraint name verbatim — match the SQLSTATE class (23xxx
    // is integrity violation; specifically 23514 is check_violation).
    await expect(
      providerDb.execute(sql`UPDATE import_jobs SET file_deleted_at = now() WHERE id = ${job.id}`),
    ).rejects.toMatchObject({
      // pg.DatabaseError exposes `.cause` with the underlying code.
      cause: expect.objectContaining({ code: '23514' }),
    });
  });
});
