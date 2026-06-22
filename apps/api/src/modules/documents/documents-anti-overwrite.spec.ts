/**
 * B7 (DOCUMENT-SECURITY-AUDIT.md §6) — anti-overwrite / anti-tamper hardening
 * of the document upload+finalize path (real-DB, service-level).
 *
 * THE HOLE this suite pins closed:
 *   The presigned PUT bound only ContentType + ContentLength — no checksum,
 *   no create-only guard — and `finalize` treated a MISSING storage checksum
 *   as a PASS. So a leaked/intercepted PUT URL could SWAP an existing object's
 *   bytes AFTER the AV scan attested the original (scan-then-swap TOCTOU =
 *   דריסה), and the plain path's content_hash was never verified against the
 *   actually-stored bytes.
 *
 * THE FIX (verified here):
 *   1. The presigned PUT is CREATE-ONLY (`IfNoneMatch:'*'`) and CHECKSUM-BOUND
 *      (`x-amz-checksum-sha256` of the declared content hash). A second PUT to
 *      the same key (overwrite) is rejected by STORAGE — proven via a storage
 *      stub that enforces create-only + checksum the way R2 does.
 *   2. `finalize` is FAIL-CLOSED: a real (non-null head) object whose checksum
 *      is MISSING or MISMATCHED is REJECTED (no "undefined ⇒ pass").
 *   3. The finalize-once guard is IDEMPOTENT-FOR-SAME / REJECT-FOR-DIFFERENT:
 *      re-finalising an already-uploaded doc with the SAME declared
 *      {sizeBytes, contentHash} is a 200 no-op (retry-safety — a lost-response
 *      retry); re-finalising with DIFFERENT values is the laundering/conflict
 *      attempt and gets 409 `document_already_uploaded`. A same-value re-call
 *      re-stamps nothing and purges nothing (the create-only + checksum-bound
 *      PUT already makes a post-finalize byte swap impossible).
 *   4. A legitimate single create → upload → finalize still works.
 *
 * Harness mirrors documents-finalize-mismatch-clarity.spec.ts (createTestOrg +
 * a stub IStorageProvider + NoopFileScanProvider, driving DocumentsService
 * directly). Deterministic; sidesteps the signup throttler.
 */
import { createHash } from 'node:crypto';
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

/** sha256(hex) of a buffer — the same content_hash shape the app stores. */
function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}
/** base64 of the RAW sha256 digest — the shape R2 attests via head(). */
function sha256B64(b: Buffer): string {
  return createHash('sha256').update(b).digest('base64');
}

interface PutRecord {
  key: string;
  createOnly: boolean | undefined;
  contentSha256Hex: string | undefined;
}

/**
 * Storage stub that ENFORCES the create-only + checksum-bound PUT contract the
 * way R2/S3 does, so we can prove the anti-overwrite behaviour at the storage
 * boundary without a live bucket.
 *
 * - The presign call records the bound options (createOnly, contentSha256Hex).
 * - `simulatePut(key, bytes)` models a client PUT against a presigned URL:
 *     • createOnly + key already stored ⇒ throws PRECONDITION_FAILED (412)
 *       — this is the OVERWRITE rejection (anti-דריסה).
 *     • bound checksum that the bytes don't hash to ⇒ throws BAD_DIGEST.
 * - `head()` returns the stored object's real size + base64 sha256 (R2 shape),
 *   so finalize's layer-2 sees a STORAGE-attested checksum.
 */
class CreateOnlyChecksumStorage implements IStorageProvider {
  public readonly puts: PutRecord[] = [];
  public readonly deleted: string[] = [];
  private readonly store = new Map<string, Buffer>();
  private readonly bound = new Map<string, string | undefined>();

  async getUploadUrl(
    key: string,
    opts: { createOnly?: boolean; contentSha256Hex?: string },
  ): Promise<string> {
    this.puts.push({
      key,
      createOnly: opts.createOnly,
      contentSha256Hex: opts.contentSha256Hex,
    });
    this.bound.set(key, opts.contentSha256Hex);
    return PUT_URL;
  }

  /** Model a client PUT to the presigned URL the way R2 enforces it. */
  simulatePut(key: string, bytes: Buffer): void {
    const createOnly = this.puts.find((p) => p.key === key)?.createOnly === true;
    if (createOnly && this.store.has(key)) {
      // R2's If-None-Match:'*' rejection — the overwrite (scan-then-swap).
      throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
    }
    const boundHex = this.bound.get(key);
    if (boundHex !== undefined && sha256Hex(bytes) !== boundHex) {
      // R2's x-amz-checksum-sha256 rejection — bytes don't match the bound hash.
      throw Object.assign(new Error('BadDigest'), { name: 'BadDigest' });
    }
    this.store.set(key, bytes);
  }

  /** Force bytes into storage WITHOUT the create-only/checksum gate — models
   *  an attacker who already obtained a leaked URL or wrote out-of-band. */
  forcePut(key: string, bytes: Buffer): void {
    this.store.set(key, bytes);
  }

  async getDownloadUrl(): Promise<string> {
    return GET_URL;
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    const buf = this.store.get(key);
    if (!buf) return null;
    return { contentLength: buf.length, checksumSha256: sha256B64(buf) };
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.store.delete(key);
  }

  async putObject(): Promise<void> {}
  /** Serve the ACTUAL stored bytes so finalize's post-commit magic-byte +
   *  AV scan-gate (which reads the object) sees what was uploaded. */
  async getObjectStream(key: string): Promise<Readable> {
    const buf = this.store.get(key);
    if (!buf) throw new Error(`no object for key ${key}`);
    return Readable.from(buf);
  }
  async healthCheck(): Promise<void> {}
}

/**
 * head() that returns a non-null object whose checksum is MISSING — models a
 * REAL R2 deployment that is S3-compatible but does NOT echo
 * `x-amz-checksum-sha256` on HEAD (HIGH-1, round-2 red-team).
 *
 * Because Option A re-verifies via a BYTE RECOMPUTE on the absent-checksum
 * path, this stub also serves the actual object bytes via `getObjectStream`,
 * so finalize can recompute sha256 and compare to content_hash:
 *   • bytes that HASH to the declared content_hash → ACCEPT (no false-reject).
 *   • bytes that DON'T hash to it (tamper)        → REJECT + purge.
 */
class NoChecksumStorage implements IStorageProvider {
  public readonly deleted: string[] = [];
  constructor(private readonly bytes: Buffer) {}
  async getUploadUrl(): Promise<string> {
    return PUT_URL;
  }
  async getDownloadUrl(): Promise<string> {
    return GET_URL;
  }
  async head(): Promise<StorageObjectMeta | null> {
    // Real object present (non-null) but NO checksum attested (R2 omitted it).
    return { contentLength: this.bytes.length };
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
  async putObject(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    // Serve the real stored bytes so the absent-checksum recompute can run.
    return Readable.from(this.bytes);
  }
  async healthCheck(): Promise<void> {}
}

let org: TestOrg;
let managerId: string;
let projectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000e1';

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
  return new DocumentsService(storage, new NoopFileScanProvider(), new NotificationsProducerService());
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `anti-overwrite-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('B7 — anti-overwrite presigned PUT + finalize integrity', () => {
  it('A) the presigned PUT is CREATE-ONLY and CHECKSUM-BOUND', async () => {
    const storage = new CreateOnlyChecksumStorage();
    const svc = makeSvc(storage);
    const bytes = Buffer.from('%PDF-1.4 the original scanned bytes');
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      contentHash: sha256Hex(bytes),
      projectId,
    });
    expect(created.uploadUrl, 'a plain doc still gets a presigned PUT').toBe(PUT_URL);
    const put = storage.puts.at(-1)!;
    // The create-only guard + the checksum binding are both present.
    expect(put.createOnly, 'PUT must be create-only (IfNoneMatch:* anti-overwrite)').toBe(true);
    expect(put.contentSha256Hex, 'PUT must bind the declared content hash').toBe(sha256Hex(bytes));
  }, 30_000);

  it('B) a second PUT to the same key (OVERWRITE) is rejected by storage', async () => {
    const storage = new CreateOnlyChecksumStorage();
    const svc = makeSvc(storage);
    const original = Buffer.from('%PDF-1.4 original');
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: original.length,
      contentHash: sha256Hex(original),
      projectId,
    });
    const key = storage.puts.at(-1)!.key;
    // First (legitimate) PUT stores the original bytes.
    expect(() => storage.simulatePut(key, original)).not.toThrow();
    // Second PUT to the SAME key — the scan-then-swap — is refused by storage.
    const tampered = Buffer.from('%PDF-1.4 SWAPPED malicious bytes');
    expect(
      () => storage.simulatePut(key, tampered),
      'overwrite PUT to an existing key must be rejected (anti-דריסה)',
    ).toThrowError(/PreconditionFailed/);
    void created;
  }, 30_000);

  it('B2) a checksum-mismatched PUT (right key, wrong bytes) is rejected by storage', async () => {
    const storage = new CreateOnlyChecksumStorage();
    const svc = makeSvc(storage);
    const declared = Buffer.from('%PDF-1.4 declared');
    await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: declared.length,
      contentHash: sha256Hex(declared),
      projectId,
    });
    const key = storage.puts.at(-1)!.key;
    // Same key, but bytes that DON'T hash to the bound checksum — rejected.
    expect(
      () => storage.simulatePut(key, Buffer.from('%PDF-1.4 OTHER bytes entirely')),
      'a PUT whose bytes mismatch the bound checksum must be rejected',
    ).toThrowError(/BadDigest/);
  }, 30_000);

  it('C0) HIGH-1: head() with NO checksum + matching bytes → ACCEPTS (no false-reject)', async () => {
    // Models a real S3-COMPATIBLE R2 that does NOT echo x-amz-checksum-sha256 on
    // HEAD. The OLD code rejected this unconditionally ⇒ EVERY legit upload
    // failed. Option A recomputes sha256 from the bytes and, on a MATCH, accepts.
    const bytes = Buffer.from('%PDF-1.4 a real upload whose R2 omits the HEAD checksum');
    const storage = new NoChecksumStorage(bytes);
    const svc = makeSvc(storage);
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      contentHash: sha256Hex(bytes),
      projectId,
    });
    let thrown: unknown;
    try {
      await svc.finalize(manager(), created.document.id, {
        sizeBytes: bytes.length,
        contentHash: sha256Hex(bytes),
      });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      'an absent HEAD checksum whose bytes hash to content_hash must NOT false-reject',
    ).toBeUndefined();
    expect(storage.deleted, 'an accepted finalize must not purge').toHaveLength(0);
  }, 30_000);

  it('C) HIGH-1 FAIL-CLOSED: head() with NO checksum + MISMATCHED bytes is rejected + purged', async () => {
    // Same absent-checksum path, but the stored bytes DON'T hash to the
    // client-declared content_hash (tamper written outside our bound PUT). The
    // byte-recompute fallback must still REJECT + purge — Option A stays
    // fail-closed; it is NOT a blanket accept-on-missing-checksum.
    const stored = Buffer.from('%PDF-1.4 SWAPPED bytes that do not match content_hash');
    const storage = new NoChecksumStorage(stored);
    const svc = makeSvc(storage);
    const declared = Buffer.from('%PDF-1.4 the bytes the client declared');
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      // Layer-1 (client size/hash self-consistency) passes: the client declares
      // its own bytes consistently at create AND finalize; only the STORED bytes
      // differ. Size matches so the recompute (not size) is what catches it.
      sizeBytes: stored.length,
      contentHash: sha256Hex(declared),
      projectId,
    });
    let thrown: unknown;
    try {
      await svc.finalize(manager(), created.document.id, {
        sizeBytes: stored.length,
        contentHash: sha256Hex(declared),
      });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      'an absent HEAD checksum whose recomputed hash mismatches must reject finalize',
    ).toBeInstanceOf(ConflictException);
    expect(
      storage.deleted.length,
      'a rejected finalize must still purge the object',
    ).toBeGreaterThan(0);
  }, 30_000);

  it('C2) finalize FAIL-CLOSED: a MISMATCHED stored checksum is rejected', async () => {
    // The object was written out-of-band (forcePut) with DIFFERENT bytes than
    // the client declared. Layer-1 passes (client lied consistently), but the
    // storage-attested checksum doesn't match content_hash ⇒ reject.
    const storage = new CreateOnlyChecksumStorage();
    const svc = makeSvc(storage);
    const declared = Buffer.from('the bytes the client claims');
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: declared.length,
      contentHash: sha256Hex(declared),
      projectId,
    });
    const key = storage.puts.at(-1)!.key;
    // Attacker stores DIFFERENT bytes of the SAME length at the key.
    const swapped = Buffer.alloc(declared.length, 0x41); // same length, different content
    storage.forcePut(key, swapped);
    let thrown: unknown;
    try {
      await svc.finalize(manager(), created.document.id, {
        sizeBytes: declared.length,
        contentHash: sha256Hex(declared),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a mismatched stored checksum must reject finalize').toBeInstanceOf(
      ConflictException,
    );
  }, 30_000);

  it('D) finalize-once is IDEMPOTENT-for-same, REJECT-for-different (retry-safety + B7 laundering-block)', async () => {
    const storage = new CreateOnlyChecksumStorage();
    const svc = makeSvc(storage);
    const bytes = Buffer.from('%PDF-1.4 legit single upload');
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      contentHash: sha256Hex(bytes),
      projectId,
    });
    const key = storage.puts.at(-1)!.key;
    storage.simulatePut(key, bytes); // the legitimate single PUT
    // First finalize succeeds.
    const first = await svc.finalize(manager(), created.document.id, {
      sizeBytes: bytes.length,
      contentHash: sha256Hex(bytes),
    });

    // Re-finalize with the SAME declared values → idempotent no-op (HTTP 200):
    // returns the already-finalised doc, purges nothing, re-stamps nothing.
    // This is the retry-safety contract (documents-deep.contract DD4 / the
    // documents-deep idempotency case): a client whose first finalize response
    // was lost to a network blip MUST be able to safely retry.
    const purgesBefore = storage.deleted.length;
    const second = await svc.finalize(manager(), created.document.id, {
      sizeBytes: bytes.length,
      contentHash: sha256Hex(bytes),
    });
    expect(second.id, 'idempotent re-finalize returns the same finalised doc').toBe(first.id);
    expect(
      storage.deleted.length,
      'an idempotent same-value re-finalize must NOT purge the object',
    ).toBe(purgesBefore);

    // Re-finalize with DIFFERENT declared values → 409 document_already_uploaded.
    // This is the actual conflict/laundering attempt the B7 guard blocks; the
    // immutable doc is NOT re-stamped and the new values are rejected.
    let thrown: unknown;
    try {
      await svc.finalize(manager(), created.document.id, {
        sizeBytes: bytes.length + 1, // a CONFLICTING re-declaration
        contentHash: sha256Hex(Buffer.from('%PDF-1.4 a DIFFERENT laundered body')),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a conflicting (different-value) re-finalize must be rejected').toBeInstanceOf(
      ConflictException,
    );
    const body =
      thrown instanceof ConflictException
        ? (thrown.getResponse() as { error?: { code?: string } })
        : undefined;
    expect(
      body?.error?.code,
      'a conflicting re-finalize must surface document_already_uploaded',
    ).toBe('document_already_uploaded');
  }, 30_000);

  it('E) a legitimate single create → upload → finalize still WORKS', async () => {
    const storage = new CreateOnlyChecksumStorage();
    const svc = makeSvc(storage);
    const bytes = Buffer.from('%PDF-1.4 a perfectly normal document');
    const created = await svc.create(manager(), {
      name: 'plan.pdf',
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      contentHash: sha256Hex(bytes),
      projectId,
    });
    const key = storage.puts.at(-1)!.key;
    storage.simulatePut(key, bytes); // single create-only PUT, bytes match
    let thrown: unknown;
    try {
      await svc.finalize(manager(), created.document.id, {
        sizeBytes: bytes.length,
        contentHash: sha256Hex(bytes),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a clean single upload must finalize without throwing').toBeUndefined();
    expect(storage.deleted, 'a clean finalize must not purge').toHaveLength(0);
  }, 30_000);
});
