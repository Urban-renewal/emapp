/**
 * Slice 5c (BE) — finalize integrity-mismatch error CLARITY (real-DB, service-level).
 *
 * INDEPENDENT acceptance test, authored from the SPEC before the builder.
 *
 * SPEC (secondary): documents `finalize` currently signals a size/hash
 * cross-check failure with a SINGLE opaque code (`document_integrity_mismatch`)
 * for BOTH the size-mismatch and the hash-mismatch case — live-observed as an
 * un-actionable error with no detail about WHICH attribute drifted. The owner
 * who re-uploads a truncated file vs. a tampered file gets the identical,
 * uninformative response.
 *
 * This suite pins the IMPROVED contract: the mismatch error must be ACTIONABLE
 * — the error code (and/or its `details`) must distinguish a size mismatch from
 * a hash mismatch, so the FE can tell the owner exactly what to fix.
 *
 *   Accepted "actionable" shapes (the builder may pick one — the assertions
 *   below accept ANY of them, but REJECT the bare opaque code):
 *     • a specific top-level code: `document_size_mismatch` | `size_mismatch`
 *       for size, `document_hash_mismatch` | `hash_mismatch` for hash; OR
 *     • the existing `document_integrity_mismatch` code BUT with a non-empty
 *       `details` that names the offending field (`sizeBytes` / `contentHash`).
 *
 * RED today: `finalize` throws `ConflictException({error:{code:
 * 'document_integrity_mismatch'}})` with NO details for every mismatch — so
 * neither the size case nor the hash case is distinguishable. Both M1 and M2
 * below FAIL until the builder makes the error actionable.
 *
 * Harness mirrors documents-scan-gate.spec.ts: createTestOrg + a stub
 * IStorageProvider (head()=null so the LAYER-1 client-consistency check stands
 * alone) + NoopFileScanProvider, driving DocumentsService.finalize directly.
 * Deterministic; sidesteps the signup throttler.
 */
import { Readable } from 'node:stream';

import { NoopFileScanProvider, type IStorageProvider, type StorageObjectMeta } from '@emapp/db';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

const PUT_URL = 'https://r2.example.test/presigned-put';
const GET_URL = 'https://r2.example.test/presigned-get';

/** Stub storage. `head()` returns the configured meta (default null → no
 *  storage attestation, so the LAYER-1 declared-vs-finalize client check is the
 *  sole gate). Records delete() so we can confirm the mismatch still purges. */
class StubStorage implements IStorageProvider {
  public readonly deleted: string[] = [];
  constructor(private readonly headMeta: StorageObjectMeta | null = null) {}
  async getUploadUrl(): Promise<string> {
    return PUT_URL;
  }
  async getDownloadUrl(): Promise<string> {
    return GET_URL;
  }
  async head(): Promise<StorageObjectMeta | null> {
    return this.headMeta;
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
  // 7d interface parity — never reached by this suite.
  async putObject(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    return Readable.from([Buffer.from('%PDF-1.4 fake bytes')]);
  }
  async healthCheck(): Promise<void> {}
}

let org: TestOrg;
let managerId: string;
let projectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function makeSvc(storage: IStorageProvider): DocumentsService {
  return new DocumentsService(
    storage,
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
}

interface ErrShape {
  code: string | undefined;
  details: unknown;
}

/** Pull `{ code, details }` out of a thrown Nest HttpException envelope. */
function errShape(e: unknown): ErrShape {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const err = (body as { error?: { code?: unknown; details?: unknown } })?.error;
    return {
      code: typeof err?.code === 'string' ? err.code : undefined,
      details: err?.details,
    };
  }
  return { code: undefined, details: undefined };
}

/** Does this thrown error ACTIONABLY identify a SIZE mismatch? */
function isActionableSize(s: ErrShape): boolean {
  if (s.code === 'document_size_mismatch' || s.code === 'size_mismatch') return true;
  // Or the legacy code retained but with details naming the size field.
  return (
    s.code === 'document_integrity_mismatch' && JSON.stringify(s.details ?? '').includes('size')
  );
}

/** Does this thrown error ACTIONABLY identify a HASH mismatch? */
function isActionableHash(s: ErrShape): boolean {
  if (s.code === 'document_hash_mismatch' || s.code === 'hash_mismatch') return true;
  return (
    s.code === 'document_integrity_mismatch' &&
    /hash|contenthash|content_hash/i.test(JSON.stringify(s.details ?? ''))
  );
}

/** Create a doc declaring (sizeBytes, contentHash), then finalize with the
 *  given (finalizeSize, finalizeHash). Returns the thrown error (if any). */
async function createThenFinalize(
  svc: DocumentsService,
  declare: { sizeBytes: number; contentHash: string },
  finalizeWith: { sizeBytes: number; contentHash: string },
): Promise<unknown> {
  const created = await svc.create(manager(), {
    name: 'plan.pdf',
    type: 'other',
    mimeType: 'application/pdf',
    sizeBytes: declare.sizeBytes,
    contentHash: declare.contentHash,
    projectId,
  });
  try {
    await svc.finalize(manager(), created.document.id, finalizeWith);
    return undefined;
  } catch (e) {
    return e;
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `fin-clarity-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('Slice 5c — finalize integrity mismatch returns an ACTIONABLE code', () => {
  it('M1) SIZE mismatch → a size-specific, actionable error (NOT a bare opaque code)', async () => {
    const storage = new StubStorage(null);
    const svc = makeSvc(storage);
    // Declared size 2048, finalize claims 9 — a size drift; hash matches.
    const thrown = await createThenFinalize(
      svc,
      { sizeBytes: 2048, contentHash: 'h-same' },
      { sizeBytes: 9, contentHash: 'h-same' },
    );
    // Still a 409 conflict + still purges the object (security contract unchanged).
    expect(thrown, 'a size mismatch must reject finalize').toBeInstanceOf(ConflictException);
    expect(storage.deleted.length, 'mismatch must still purge the object').toBeGreaterThan(0);

    const s = errShape(thrown);
    // RED: today s.code === 'document_integrity_mismatch' with details === undefined,
    // so isActionableSize() is false → this assertion fails until the builder
    // makes the size case distinguishable.
    expect(
      isActionableSize(s),
      `size mismatch must be actionable, got code=${String(s.code)} details=${JSON.stringify(s.details)}`,
    ).toBe(true);
  }, 30_000);

  it('M2) HASH mismatch → a hash-specific, actionable error (NOT a bare opaque code)', async () => {
    const storage = new StubStorage(null);
    const svc = makeSvc(storage);
    // Declared hash 'h-real', finalize claims 'h-tampered'; size matches.
    const thrown = await createThenFinalize(
      svc,
      { sizeBytes: 4096, contentHash: 'h-real' },
      { sizeBytes: 4096, contentHash: 'h-tampered' },
    );
    expect(thrown, 'a hash mismatch must reject finalize').toBeInstanceOf(ConflictException);
    expect(storage.deleted.length, 'mismatch must still purge the object').toBeGreaterThan(0);

    const s = errShape(thrown);
    expect(
      isActionableHash(s),
      `hash mismatch must be actionable, got code=${String(s.code)} details=${JSON.stringify(s.details)}`,
    ).toBe(true);
  }, 30_000);

  it('M3) size vs hash mismatch are DISTINGUISHABLE from each other', async () => {
    // The whole point of "actionable": the two failures must not collapse to an
    // identical response. Drive both and assert their (code, details) differ.
    const sizeThrown = await createThenFinalize(
      makeSvc(new StubStorage(null)),
      { sizeBytes: 2048, contentHash: 'h-x' },
      { sizeBytes: 7, contentHash: 'h-x' },
    );
    const hashThrown = await createThenFinalize(
      makeSvc(new StubStorage(null)),
      { sizeBytes: 2048, contentHash: 'h-x' },
      { sizeBytes: 2048, contentHash: 'h-y' },
    );
    const sizeSig = JSON.stringify(errShape(sizeThrown));
    const hashSig = JSON.stringify(errShape(hashThrown));
    // RED: both are {code:'document_integrity_mismatch', details:undefined} →
    // identical signatures → this fails. GREEN once they carry distinct info.
    expect(sizeSig, `size & hash mismatch must be distinguishable; both were ${sizeSig}`).not.toBe(
      hashSig,
    );
  }, 30_000);

  it('M4) a MATCHING finalize still succeeds (no regression / over-rejection)', async () => {
    const storage = new StubStorage(null);
    const svc = makeSvc(storage);
    const thrown = await createThenFinalize(
      svc,
      { sizeBytes: 1234, contentHash: 'h-match' },
      { sizeBytes: 1234, contentHash: 'h-match' },
    );
    expect(thrown, 'a matching finalize must NOT throw').toBeUndefined();
    expect(storage.deleted, 'a clean finalize must not purge').toHaveLength(0);
  }, 30_000);
});
