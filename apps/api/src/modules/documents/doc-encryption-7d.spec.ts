/**
 * 7d — app-envelope encryption for SENSITIVE document bytes (TEST-AUTHOR,
 * independent, RED-first). DO NOT modify implementation/schema/migration to
 * make these pass — that is the builder's job. This file only asserts the
 * target behavior per docs/DESIGN-phase5-tabu-extraction.md §7d (option (a):
 * app-envelope for sensitive docs only; D-P5.4 second half).
 *
 * SPEC PINNED BY THESE TESTS (single adjust points marked):
 *
 *   Migration 0072 (`when` MUST be > 1782831600000 of 0071; suggested
 *   1782918000000), hand-authored .sql + meta/_journal.json entry:
 *     - ALTER TABLE documents ADD COLUMN bytes_encrypted boolean NOT NULL
 *       DEFAULT false;
 *
 *   IStorageProvider gains putObject (packages/db/src/providers/storage/
 *   storage.interface.ts; implemented by BOTH R2StorageProvider and
 *   FakeStorageProvider — the Fake stores into its in-memory `objects` map so
 *   tests can read back exactly what was PUT):
 *     putObject(key: string, body: Buffer, opts?: { contentType?: string }):
 *       Promise<void>
 *
 *   Key management — DOC_ENCRYPTION_KEY:
 *     - declared in packages/db/src/env.ts serverSchema EXACTLY like
 *       PII_ENCRYPTION_KEY (z.string().length(44) — base64 of 32 bytes),
 *       delivered via Infisical; the service reads `env.DOC_ENCRYPTION_KEY`
 *       from the @emapp/db env module — NEVER a hardcoded key, NEVER logged.
 *     - VERIFIED ABSENT from Infisical dev on 2026-06-12 (15 secrets, PII_*
 *       present, DOC_ENCRYPTION_KEY not). Until the owner adds it, this spec
 *       seeds a DOCUMENTED TEST-ONLY value into process.env in beforeAll and
 *       calls reloadEnv() so the @emapp/db env snapshot picks it up. The G
 *       round-trip test decrypts with THAT key — which functionally pins that
 *       the builder's cipher uses base64-decoded env.DOC_ENCRYPTION_KEY.
 *
 *   Sensitive upload route (presign for sensitive docs is CLOSED):
 *     - POST /api/v1/documents/:id/content — RAW body (application/octet-
 *       stream), per-route bodyLimit 52_428_800; service method (pinned name):
 *         DocumentsService.uploadContent(user, id, body: Buffer)
 *           → Promise<{ uploaded: true }>          (wire: 200 {data:{uploaded:true}})
 *       Flow: doc must be SENSITIVE + visible + NOT yet uploaded → verify
 *       sha256(raw)+size against the row's create-declared contentHash/
 *       sizeBytes (mismatch → 400 document_integrity_mismatch with
 *       details.field='hash'|'size', NOTHING stored) → scan the PLAINTEXT
 *       via the injected IFileScanProvider (non-clean → same fail-closed
 *       archive+reject posture as the presign path: 409
 *       document_scan_rejected, nothing decryptable at rest) → encrypt
 *       AES-256-GCM with DOC_ENCRYPTION_KEY → storage.putObject(r2Key) →
 *       stamp uploaded_at + scan_status + bytes_encrypted=true.
 *       A NON-sensitive doc → 400/409 (presign flow is the only path for it).
 *     - POST /documents creating a SENSITIVE doc returns NO presigned PUT:
 *       uploadUrl null/absent + `contentUploadPath` containing
 *       `/documents/<id>/content` instead. (Plain docs: uploadUrl unchanged.)
 *
 *   Envelope AT REST (self-describing, no migration needed for the format):
 *     Buffer layout = 'EMAPPENC' (8B ascii) | version (1B = 0x01) |
 *     keyId (2B) | iv (12B) | tag (16B) | ciphertext (same length as
 *     plaintext — GCM). NO additional AAD (the G test decrypts with
 *     createDecipheriv('aes-256-gcm', key, iv) + setAuthTag(tag) ONLY; a
 *     builder wanting AAD must come back to this spec first).
 *
 *   Sensitive download (existing GET /documents/:id/download, already
 *   OTP-gated): when bytes_encrypted=true the API DECRYPT-STREAMS the bytes
 *   itself instead of minting a presigned URL; service method (pinned name):
 *     DocumentsService.getDecryptedStream(user, id, disposition?)
 *       → Promise<{ stream: Readable; mimeType: string; ... }>
 *   The PII step-up gate applies unchanged (403 pii_step_up_required without
 *   a valid session unlock). Plain docs keep the byte-identical presign path.
 *
 * LAYER + RED MODEL (honest):
 *   Real-DB, in-process service harness (mirrors documents-scan-gate.spec +
 *   step-up-pii-unlock.spec). RED today because:
 *     - migration 0072 has not landed → documents.bytes_encrypted missing
 *       (M tests; 42703 in helpers that select it);
 *     - IStorageProvider/FakeStorageProvider have no putObject (P tests);
 *     - packages/db/src/env.ts has no DOC_ENCRYPTION_KEY (P3);
 *     - DocumentsService has no uploadContent/getDecryptedStream → guarded
 *       method resolution throws a clear [RED] message (A/B/C/D/G);
 *     - create() still returns a presigned PUT for sensitive docs (F);
 *     - documents.controller.ts has no :id/content route and gen-api-docs.ts
 *       has no /api/v1/documents/:id/content entry (H).
 *   E1 (plain-doc presign regression) is GREEN today BY DESIGN — it pins the
 *   "regular documents: unchanged" half of the 7d decision.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/doc-encryption-7d.spec.ts
 */
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  FakeStorageProvider,
  NoopFileScanProvider,
  reloadEnv,
  type IFileScanProvider,
  type ScanInput,
  type ScanResult,
} from '@emapp/db';
import {
  DOCUMENT_SCAN_REJECTED_CODE,
  type CreateDocument,
  type DocumentUploadResponse,
} from '@emapp/shared-types';
import { HttpException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

// ── Pinned contract names (single adjust points for the builder) ────────────
const UPLOAD_CONTENT_METHOD = 'uploadContent';
const DECRYPTED_STREAM_METHOD = 'getDecryptedStream';
const CONTENT_UPLOAD_PATH_FIELD = 'contentUploadPath';
const ENVELOPE_MAGIC = 'EMAPPENC'; // 8 ascii bytes
const ENVELOPE_VERSION = 1;
/** magic(8) + version(1) + keyId(2) + iv(12) + tag(16) */
const ENVELOPE_HEADER_LEN = 8 + 1 + 2 + 12 + 16;
const INTEGRITY_MISMATCH = 'document_integrity_mismatch';
const PII_STEP_UP_REQUIRED = 'pii_step_up_required';
/** 0071's journal `when` — migration 0072 MUST be strictly greater (M-1:
 *  the migrator SILENTLY SKIPS a migration whose `when` <= max-applied). */
const PREV_MIGRATION_WHEN = 1782831600000;
const CONTENT_ROUTE_DOC = '/api/v1/documents/:id/content';
const CONTENT_BODY_LIMIT_RE = /52[_,]?428[_,]?800/;

// TEST-ONLY key material (NOT a real credential): exactly 32 ascii bytes →
// 44-char base64, the same shape env.ts enforces for PII_ENCRYPTION_KEY.
// Built from a readable literal so the secret-scanner doesn't false-positive.
const TEST_DOC_KEY_BYTES = Buffer.from('emapp-7d-test-doc-key-32bytes!!!');

const PKG_DB = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../packages/db');
const MIGRATIONS_DIR = join(PKG_DB, 'migrations');
const STORAGE_INTERFACE = join(PKG_DB, 'src/providers/storage/storage.interface.ts');
const R2_PROVIDER = join(PKG_DB, 'src/providers/storage/r2.provider.ts');
const DB_ENV = join(PKG_DB, 'src/env.ts');
const API_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const GEN_API_DOCS = join(API_ROOT, 'scripts/gen-api-docs.ts');
const DOCUMENTS_CONTROLLER = join(API_ROOT, 'src/modules/documents/documents.controller.ts');

// ── fixtures ─────────────────────────────────────────────────────────────────
let org: TestOrg;
let managerId: string;
let projectId: string;

/** Known plaintext (binary-safe: includes Hebrew bytes) for the round-trips. */
const PLAINTEXT = Buffer.from('%PDF-1.4\n7d round-trip plaintext — נסח טאבו בדיקה\n%%EOF\n');

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function payload(sid: string): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function errCode(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const code = (body as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errField(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const field = (body as { error?: { details?: { field?: unknown } } })?.error?.details?.field;
    return typeof field === 'string' ? field : undefined;
  }
  return undefined;
}

function errStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// ── raw-SQL helpers (providerPool = BYPASSRLS) ──────────────────────────────
async function docCore(id: string): Promise<{
  r2_key: string;
  uploaded_at: Date | null;
  scan_status: string;
  archived_at: Date | null;
}> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      r2_key: string;
      uploaded_at: Date | null;
      scan_status: string;
      archived_at: Date | null;
    }>(`SELECT r2_key, uploaded_at, scan_status, archived_at FROM documents WHERE id = $1`, [id]);
    expect(r.rows.length, `document row ${id} missing`).toBe(1);
    return r.rows[0]!;
  } finally {
    c.release();
  }
}

/** RED today: 42703 undefined_column until migration 0072 lands. */
async function docBytesEncrypted(id: string): Promise<boolean> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ bytes_encrypted: boolean }>(
      `SELECT bytes_encrypted FROM documents WHERE id = $1`,
      [id],
    );
    return r.rows[0]!.bytes_encrypted;
  } finally {
    c.release();
  }
}

/** A live auth_sessions row (the session the PII unlock is stamped on). */
async function seedSession(userId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 days') RETURNING id`,
      [userId, `doc7d-test-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function setUnlock(sessionId: string, agoMinutes: number): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE auth_sessions
       SET pii_unlocked_at = now() - make_interval(mins => $2::int)
       WHERE id = $1`,
      [sessionId, agoMinutes],
    );
  } finally {
    c.release();
  }
}

// ── stubs / harness ──────────────────────────────────────────────────────────

/** Scanner that records the EXACT bytes it was given (resolving the lazy
 *  loader) — pins "the scan runs on the PLAINTEXT, not the ciphertext". */
class RecordingScanProvider implements IFileScanProvider {
  public seen: Buffer | null = null;
  constructor(private readonly result: ScanResult) {}
  async scan(input: ScanInput): Promise<ScanResult> {
    if (typeof input.bytes === 'function') this.seen = await input.bytes();
    else if (input.bytes) this.seen = input.bytes;
    return this.result;
  }
  async healthCheck(): Promise<void> {}
}

function makeSvc(storage: FakeStorageProvider, scanner: IFileScanProvider): DocumentsService {
  return new DocumentsService(storage, scanner, new NotificationsProducerService());
}

/** Guarded method resolution — the builder's RED signal with a clear remedy. */
function svcFn(
  svc: DocumentsService,
  name: string,
): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const fn = (svc as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `[RED] DocumentsService.${name}() missing — builder must land 7d ` +
        `(docs/DESIGN-phase5-tabu-extraction.md §7d; pinned names in doc-encryption-7d.spec.ts).`,
    );
  }
  return (fn as (...args: unknown[]) => Promise<Record<string, unknown>>).bind(svc);
}

function sensitiveInput(plain: Buffer, over: Record<string, unknown> = {}): CreateDocument {
  return {
    name: 'nesach-7d.pdf',
    type: 'id_document', // sensitive-by-type (D-P5.7)
    mimeType: 'application/pdf',
    sizeBytes: plain.length,
    contentHash: sha256hex(plain),
    projectId,
    ...over,
  } as unknown as CreateDocument;
}

/** create(sensitive) + uploadContent(plaintext) through the given service. */
async function createAndUpload(
  svc: DocumentsService,
  plain: Buffer,
  over: Record<string, unknown> = {},
): Promise<{ id: string; r2Key: string }> {
  const created = await svc.create(payload(randomUUID()), sensitiveInput(plain, over));
  const id = created.document.id;
  await svcFn(svc, UPLOAD_CONTENT_METHOD)(payload(randomUUID()), id, plain);
  const { r2_key } = await docCore(id);
  return { id, r2Key: r2_key };
}

beforeAll(async () => {
  await setupTestDatabase();
  // DOC_ENCRYPTION_KEY is NOT in Infisical dev yet (verified 2026-06-12).
  // Seed the documented test value so the builder's env-module read works;
  // when the owner later adds the real secret, the ??= keeps it authoritative.
  process.env['DOC_ENCRYPTION_KEY'] ??= TEST_DOC_KEY_BYTES.toString('base64');
  reloadEnv(); // re-snapshot @emapp/db env in place (v8 §v7-C)
  const tag = `s7d-encdoc-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 120_000);

// ───────────────────────────────────────────────────────────────────────────
// M) migration 0072 — documents.bytes_encrypted
// ───────────────────────────────────────────────────────────────────────────
describe('7d · M) migration 0072 (bytes_encrypted)', () => {
  it('M1) documents.bytes_encrypted — boolean NOT NULL DEFAULT false', async () => {
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ data_type: string; is_nullable: string; column_default: string }>(
        `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='documents'
           AND column_name='bytes_encrypted'`,
      );
      expect(r.rows.length, '[RED] documents.bytes_encrypted missing (migration 0072)').toBe(1);
      expect(r.rows[0]!.data_type).toBe('boolean');
      expect(r.rows[0]!.is_nullable).toBe('NO');
      expect(r.rows[0]!.column_default).toContain('false');
    } finally {
      c.release();
    }
  }, 30_000);

  it(`M2) journal entry \`when\` > ${PREV_MIGRATION_WHEN} (0071) for the .sql adding bytes_encrypted`, () => {
    const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const migFile = sqlFiles.find((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('bytes_encrypted'),
    );
    expect(
      migFile,
      '[RED] no migration .sql mentions bytes_encrypted — builder must hand-author 0072',
    ).toBeTruthy();
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> };
    const tag = migFile!.replace(/\.sql$/, '');
    const entry = journal.entries.find((j) => j.tag === tag);
    expect(entry, `[RED] meta/_journal.json has no entry for ${tag}`).toBeTruthy();
    expect(
      entry!.when,
      'migrator silently skips when <= max-applied (M-1) — use e.g. 1782918000000',
    ).toBeGreaterThan(PREV_MIGRATION_WHEN);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// P) provider seam — putObject + DOC_ENCRYPTION_KEY via the env module
// ───────────────────────────────────────────────────────────────────────────
describe('7d · P) IStorageProvider.putObject + key plumbing', () => {
  it('P1) FakeStorageProvider.putObject stores bytes readable back via getObjectStream', async () => {
    const fake = new FakeStorageProvider();
    const put = (fake as unknown as Record<string, unknown>)['putObject'];
    if (typeof put !== 'function') {
      throw new Error(
        '[RED] FakeStorageProvider.putObject missing — builder must add putObject to ' +
          'IStorageProvider (R2 + Fake; Fake stores into its in-memory `objects` map).',
      );
    }
    const key = `org/test/doc/${randomUUID()}`;
    const body = Buffer.from('putObject round-trip bytes');
    await (put as (k: string, b: Buffer, o?: { contentType?: string }) => Promise<void>).call(
      fake,
      key,
      body,
      { contentType: 'application/octet-stream' },
    );
    expect(fake.objects.get(key)?.equals(body), 'Fake must store the PUT bytes in-memory').toBe(
      true,
    );
    const back = await collect(await fake.getObjectStream(key));
    expect(back.equals(body)).toBe(true);
  }, 30_000);

  it('P2) static — storage.interface.ts declares putObject and r2.provider.ts implements it', () => {
    const iface = readFileSync(STORAGE_INTERFACE, 'utf8');
    expect(
      iface.includes('putObject('),
      '[RED] IStorageProvider has no putObject() — required for the 7d server-side write',
    ).toBe(true);
    const r2 = readFileSync(R2_PROVIDER, 'utf8');
    expect(r2.includes('putObject'), '[RED] R2StorageProvider does not implement putObject').toBe(
      true,
    );
  });

  it('P3) static — DOC_ENCRYPTION_KEY declared in packages/db/src/env.ts (Infisical-delivered, PII-key shape)', () => {
    const envSrc = readFileSync(DB_ENV, 'utf8');
    expect(
      envSrc.includes('DOC_ENCRYPTION_KEY'),
      '[RED] DOC_ENCRYPTION_KEY missing from the @emapp/db env schema — the service must read ' +
        'env.DOC_ENCRYPTION_KEY (same channel as PII_ENCRYPTION_KEY), never a hardcoded key',
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A) content-upload happy path
// ───────────────────────────────────────────────────────────────────────────
describe('7d · A) POST /documents/:id/content — happy path', () => {
  it('A1) bytes AT REST are an EMAPPENC envelope (no plaintext); row uploaded+clean+bytes_encrypted; scan saw the PLAINTEXT', async () => {
    const fake = new FakeStorageProvider();
    const scanner = new RecordingScanProvider({ verdict: 'clean' });
    const svc = makeSvc(fake, scanner);

    const created = await svc.create(payload(randomUUID()), sensitiveInput(PLAINTEXT));
    const id = created.document.id;
    const res = await svcFn(svc, UPLOAD_CONTENT_METHOD)(payload(randomUUID()), id, PLAINTEXT);
    expect(res['uploaded'], 'uploadContent must resolve { uploaded: true }').toBe(true);

    const row = await docCore(id);
    // At rest: the self-describing envelope, NEVER the plaintext.
    const stored = fake.objects.get(row.r2_key);
    expect(stored, 'no object stored under the doc r2Key — putObject not called?').toBeTruthy();
    expect(stored!.subarray(0, 8).toString('utf8')).toBe(ENVELOPE_MAGIC);
    expect(stored!.includes(PLAINTEXT), 'PLAINTEXT found at rest — bytes are not encrypted').toBe(
      false,
    );

    // Row stamped: uploaded + clean + bytes_encrypted=true (migration 0072).
    expect(row.uploaded_at, 'uploaded_at must be stamped').not.toBeNull();
    expect(row.scan_status).toBe('clean');
    expect(row.archived_at).toBeNull();
    expect(await docBytesEncrypted(id)).toBe(true);

    // P0.B1 preserved: the scan ran on the PLAINTEXT (not the ciphertext).
    expect(scanner.seen, 'scanner was never given the bytes').toBeTruthy();
    expect(scanner.seen!.equals(PLAINTEXT), 'scanner must receive the PLAINTEXT').toBe(true);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B) integrity attestation + path guards
// ───────────────────────────────────────────────────────────────────────────
describe('7d · B) content-upload integrity + sensitive-only guards', () => {
  it('B1) wrong HASH → 400 document_integrity_mismatch details.field=hash; NOTHING stored', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    // Declared hash ≠ sha256 of the actual raw bytes (size matches).
    const created = await svc.create(
      payload(randomUUID()),
      sensitiveInput(PLAINTEXT, { contentHash: sha256hex(Buffer.from('other bytes')) }),
    );
    let thrown: unknown;
    try {
      await svcFn(svc, UPLOAD_CONTENT_METHOD)(
        payload(randomUUID()),
        created.document.id,
        PLAINTEXT,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a hash mismatch must reject the content upload').toBeTruthy();
    expect(errStatus(thrown), 'integrity mismatch on the content path is a 400').toBe(400);
    expect(errCode(thrown)).toBe(INTEGRITY_MISMATCH);
    expect(errField(thrown)).toBe('hash');
    expect(fake.objects.size, 'mismatched bytes must NOT reach storage').toBe(0);
    const row = await docCore(created.document.id);
    expect(row.uploaded_at, 'a rejected upload must not stamp uploaded_at').toBeNull();
  }, 40_000);

  it('B2) wrong SIZE → 400 document_integrity_mismatch details.field=size; NOTHING stored', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    // Declared size ≠ actual raw length (hash declared for the real bytes —
    // size is the FIRST check, mirroring finalize's actionable ordering).
    const created = await svc.create(
      payload(randomUUID()),
      sensitiveInput(PLAINTEXT, { sizeBytes: PLAINTEXT.length + 5 }),
    );
    let thrown: unknown;
    try {
      await svcFn(svc, UPLOAD_CONTENT_METHOD)(
        payload(randomUUID()),
        created.document.id,
        PLAINTEXT,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a size mismatch must reject the content upload').toBeTruthy();
    expect(errStatus(thrown)).toBe(400);
    expect(errCode(thrown)).toBe(INTEGRITY_MISMATCH);
    expect(errField(thrown)).toBe('size');
    expect(fake.objects.size).toBe(0);
  }, 40_000);

  it('B3) an ALREADY-uploaded doc rejects a second content upload (409)', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const { id } = await createAndUpload(svc, PLAINTEXT);
    let thrown: unknown;
    try {
      await svcFn(svc, UPLOAD_CONTENT_METHOD)(payload(randomUUID()), id, PLAINTEXT);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'content re-upload over a finalized doc must reject').toBeTruthy();
    expect(errStatus(thrown)).toBe(409);
  }, 40_000);

  it('B4) a NON-sensitive doc → content route rejects (400/409 — presign is its only path); nothing stored', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const created = await svc.create(
      payload(randomUUID()),
      sensitiveInput(PLAINTEXT, { type: 'agreement' }), // not sensitive-by-type
    );
    let thrown: unknown;
    try {
      await svcFn(svc, UPLOAD_CONTENT_METHOD)(
        payload(randomUUID()),
        created.document.id,
        PLAINTEXT,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'the content route is SENSITIVE-ONLY').toBeTruthy();
    expect([400, 409]).toContain(errStatus(thrown));
    expect(fake.objects.size).toBe(0);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C) scan fail-closed on the plaintext
// ───────────────────────────────────────────────────────────────────────────
describe('7d · C) scan gate fail-closed (plaintext verdict)', () => {
  it('C1) infected verdict → 409 document_scan_rejected, row archived, NOTHING decryptable at rest', async () => {
    const fake = new FakeStorageProvider();
    const scanner = new RecordingScanProvider({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    const svc = makeSvc(fake, scanner);
    const created = await svc.create(payload(randomUUID()), sensitiveInput(PLAINTEXT));
    const id = created.document.id;

    let thrown: unknown;
    try {
      await svcFn(svc, UPLOAD_CONTENT_METHOD)(payload(randomUUID()), id, PLAINTEXT);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'an infected plaintext must reject the content upload').toBeTruthy();
    expect(errStatus(thrown)).toBe(409);
    expect(errCode(thrown)).toBe(DOCUMENT_SCAN_REJECTED_CODE);

    // Fail-closed posture (same as the presign path): archived + verdict
    // recorded + NOTHING retrievable at rest (never stored, or purged —
    // either satisfies "nothing stored decryptable").
    const row = await docCore(id);
    expect(row.archived_at, 'scan-rejected doc must be archived').not.toBeNull();
    expect(row.scan_status).toBe('infected');
    expect(row.uploaded_at, 'scan-rejected doc must not be marked uploaded-servable').toBeNull();
    expect(
      fake.objects.has(row.r2_key),
      'infected content found AT REST — must be purged/never stored',
    ).toBe(false);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// D) sensitive download — decrypt-stream behind the OTP unlock
// ───────────────────────────────────────────────────────────────────────────
describe('7d · D) sensitive download decrypt-streams (OTP gate preserved)', () => {
  it('D1) valid pii-unlock → DECRYPTED bytes === plaintext, correct mime, NO presigned URL minted', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const { id } = await createAndUpload(svc, PLAINTEXT);

    const sid = await seedSession(managerId);
    await setUnlock(sid, 0); // freshly stamped (7b-OTP machinery, already live)

    const res = (await svcFn(svc, DECRYPTED_STREAM_METHOD)(payload(sid), id)) as {
      stream?: Readable;
      mimeType?: string;
    };
    expect(res.stream, 'getDecryptedStream must return { stream }').toBeTruthy();
    const bytes = await collect(res.stream!);
    expect(bytes.equals(PLAINTEXT), 'downloaded bytes must equal the ORIGINAL plaintext').toBe(
      true,
    );
    expect(res.mimeType, 'content-type must be the doc mime').toBe('application/pdf');
    // The encrypted doc is served by the API — never via a presigned URL.
    expect(fake.downloaded.length, 'an encrypted doc must NOT mint a presigned GET').toBe(0);
  }, 40_000);

  it('D2) WITHOUT a valid unlock → 403 pii_step_up_required (7b-OTP regression on the new path)', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const { id } = await createAndUpload(svc, PLAINTEXT);

    const sid = await seedSession(managerId); // live session, NO unlock
    let thrown: unknown;
    try {
      await svcFn(svc, DECRYPTED_STREAM_METHOD)(payload(sid), id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'sensitive decrypted download served WITHOUT a PII unlock').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// E) plain-doc regression pins (GREEN today by design)
// ───────────────────────────────────────────────────────────────────────────
describe('7d · E) plain (non-sensitive) docs — byte-identical presign behavior', () => {
  it('E1) create → uploadUrl present; finalize + download presign unchanged', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const created = await svc.create(
      payload(randomUUID()),
      sensitiveInput(PLAINTEXT, { type: 'agreement', contentHash: 'h-7d-plain' }),
    );
    expect(typeof created.uploadUrl, 'plain doc create must keep returning a presigned PUT').toBe(
      'string',
    );
    expect(created.uploadUrl).toContain('fake-storage.test/upload/');

    await svc.finalize(payload(randomUUID()), created.document.id, {
      sizeBytes: PLAINTEXT.length,
      contentHash: 'h-7d-plain',
    });
    const dl = await svc.getDownloadUrl(payload(randomUUID()), created.document.id);
    expect(dl.url).toContain('fake-storage.test/download/');
    expect(fake.downloaded.length, 'plain doc download stays presign-based').toBe(1);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// F) presign upload for sensitive docs is CLOSED
// ───────────────────────────────────────────────────────────────────────────
describe('7d · F) sensitive create — no presigned PUT, contentUploadPath instead', () => {
  it('F1) creating a sensitive doc → uploadUrl null/absent + contentUploadPath → /documents/<id>/content', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const created = (await svc.create(
      payload(randomUUID()),
      sensitiveInput(PLAINTEXT),
    )) as DocumentUploadResponse & Record<string, unknown>;

    expect(
      created.uploadUrl ?? null,
      '[RED] sensitive create must NOT mint a presigned PUT (uploadUrl: null/absent) — ' +
        'the encrypted content path is the only sensitive upload route',
    ).toBeNull();
    // And no presign was minted under the hood either.
    expect(fake.uploaded.length, 'no presigned PUT may be created for a sensitive doc').toBe(0);

    const contentPath = created[CONTENT_UPLOAD_PATH_FIELD];
    expect(
      typeof contentPath,
      `[RED] sensitive create must return \`${CONTENT_UPLOAD_PATH_FIELD}\` (string)`,
    ).toBe('string');
    expect(contentPath as string).toContain(`/documents/${created.document.id}/content`);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// G) envelope format — independently decryptable with node:crypto
// ───────────────────────────────────────────────────────────────────────────
describe('7d · G) envelope format (EMAPPENC|v1|keyId|iv|tag|ct) — self-decrypt', () => {
  it('G1) stored layout parses; AES-256-GCM decrypt with the ENV key + iv + tag yields the plaintext', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake, new NoopFileScanProvider());
    const { r2Key } = await createAndUpload(svc, PLAINTEXT);

    const stored = fake.objects.get(r2Key);
    expect(stored, 'no encrypted object at rest').toBeTruthy();

    // Self-describing layout: 'EMAPPENC'(8) | version(1)=1 | keyId(2) |
    // iv(12) | tag(16) | ciphertext. GCM ⇒ ct length === plaintext length.
    expect(stored!.length).toBe(ENVELOPE_HEADER_LEN + PLAINTEXT.length);
    expect(stored!.subarray(0, 8).toString('utf8')).toBe(ENVELOPE_MAGIC);
    expect(stored![8], 'envelope version byte must be 1').toBe(ENVELOPE_VERSION);
    const iv = stored!.subarray(11, 23); // 12 bytes after the 2-byte keyId
    const tag = stored!.subarray(23, 39); // 16-byte GCM auth tag
    const ct = stored!.subarray(39);

    // The key is base64-decoded env DOC_ENCRYPTION_KEY (32 bytes) — decrypting
    // with the value WE planted in the env pins that the builder reads the env
    // module (not a hardcoded key) and uses no extra AAD/KDF.
    const key = Buffer.from(process.env['DOC_ENCRYPTION_KEY']!, 'base64');
    expect(key.length, 'DOC_ENCRYPTION_KEY must base64-decode to 32 bytes').toBe(32);
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(ct), d.final()]);
    expect(
      out.equals(PLAINTEXT),
      'independent AES-256-GCM decrypt of the envelope must yield the original plaintext',
    ).toBe(true);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// H) route + docs-coverage static pins
// ───────────────────────────────────────────────────────────────────────────
describe('7d · H) route registration + gen-api-docs coverage', () => {
  it(`H1) gen-api-docs.ts documents ${CONTENT_ROUTE_DOC}`, () => {
    const src = readFileSync(GEN_API_DOCS, 'utf8');
    expect(
      src.includes(CONTENT_ROUTE_DOC),
      `[RED] gen-api-docs.ts lacks the ${CONTENT_ROUTE_DOC} ENDPOINTS entry ` +
        '(api-docs-coverage will fail CI)',
    ).toBe(true);
  });

  it('H2) documents.controller.ts registers POST :id/content with the dedicated 52_428_800 bodyLimit', () => {
    const src = readFileSync(DOCUMENTS_CONTROLLER, 'utf8');
    expect(
      src.includes(':id/content'),
      '[RED] documents.controller.ts has no :id/content route',
    ).toBe(true);
    expect(
      CONTENT_BODY_LIMIT_RE.test(src),
      '[RED] the content route must carry the dedicated 52_428_800 (50MB) raw bodyLimit',
    ).toBe(true);
  });
});
