/**
 * 7d security review LOW-2 — envelope DECRYPT robustness pins (TEST-AUTHOR).
 *
 * These tests pin EXISTING behavior (post-LOW-1 fix) of the sensitive-doc
 * decrypt path — DocumentsService.getDecryptedStream → decryptEnvelope:
 *
 *   - Corrupted at-rest object (wrong magic / wrong version byte / truncated
 *     below the 39-byte header / GCM auth-tag failure on tampered ciphertext)
 *     → 500 { error: { code: 'document_decrypt_failed' } } and NO plaintext
 *     or partial bytes ever returned to the caller.
 *   - Key MISCONFIG at decrypt time (DOC_ENCRYPTION_KEY missing/invalid) →
 *     503 { error: { code: 'doc_encryption_unavailable' } } — the LOW-1 fix
 *     hoisted the key fetch OUT of the decrypt try/catch so an ops misconfig
 *     is NOT swallowed into the generic 500 corruption code.
 *
 * DO NOT modify the implementation to satisfy this file — it pins what the
 * builder already shipped on feat/s7d-doc-encryption. Harness mirrors
 * doc-encryption-7d.spec.ts (real DB, in-process service, FakeStorageProvider,
 * pii-unlock seeding, DOC_ENCRYPTION_KEY env seeding). This spec plants its
 * corrupted objects DIRECTLY into the Fake's in-memory map and marks the row
 * uploaded+clean+bytes_encrypted=true via SQL, so it exercises the download
 * path in isolation from uploadContent.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/doc-envelope-robustness.spec.ts
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import { FakeStorageProvider, NoopFileScanProvider, reloadEnv } from '@emapp/db';
import type { CreateDocument } from '@emapp/shared-types';
import { HttpException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

// ── Pinned wire contract ─────────────────────────────────────────────────────
const DECRYPT_FAILED = 'document_decrypt_failed'; // 500 — corruption/tamper
const ENCRYPTION_UNAVAILABLE = 'doc_encryption_unavailable'; // 503 — key misconfig
const ENVELOPE_MAGIC = 'EMAPPENC'; // 8 ascii bytes
const ENVELOPE_VERSION = 0x01;
/** magic(8) + version(1) + keyId(2) + iv(12) + tag(16) */
const ENVELOPE_HEADER_LEN = 8 + 1 + 2 + 12 + 16;

// TEST-ONLY key material (NOT a real credential) — same documented value the
// 7d spec seeds: exactly 32 ascii bytes → 44-char base64 (PII-key shape).
const TEST_DOC_KEY_BYTES = Buffer.from('emapp-7d-test-doc-key-32bytes!!!');

// ── fixtures ─────────────────────────────────────────────────────────────────
let org: TestOrg;
let managerId: string;
let projectId: string;

/** Known plaintext (binary-safe: includes Hebrew bytes) — must NEVER surface. */
const PLAINTEXT = Buffer.from('%PDF-1.4\nLOW-2 robustness plaintext — נסח טאבו בדיקה\n%%EOF\n');

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

function errStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

// ── raw-SQL helpers (providerPool = BYPASSRLS) ──────────────────────────────
/** Read the server-generated r2Key (never on the wire) for object planting. */
async function docR2Key(id: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ r2_key: string }>(`SELECT r2_key FROM documents WHERE id = $1`, [id]);
    expect(r.rows.length, `document row ${id} missing`).toBe(1);
    return r.rows[0]!.r2_key;
  } finally {
    c.release();
  }
}

/** Mark the row servable-encrypted: uploaded + clean + bytes_encrypted=true. */
async function markUploadedCleanEncrypted(id: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE documents
       SET uploaded_at = now(), scan_status = 'clean', bytes_encrypted = true
       WHERE id = $1`,
      [id],
    );
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
      [userId, `doc-low2-test-${randomUUID()}`],
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

// ── harness ──────────────────────────────────────────────────────────────────
function makeSvc(storage: FakeStorageProvider): DocumentsService {
  return new DocumentsService(
    storage,
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
}

function sensitiveInput(plain: Buffer): CreateDocument {
  return {
    name: 'nesach-low2.pdf',
    type: 'id_document', // sensitive-by-type (D-P5.7)
    mimeType: 'application/pdf',
    sizeBytes: plain.length,
    contentHash: sha256hex(plain),
    projectId,
  } as unknown as CreateDocument;
}

/**
 * Build a GENUINE at-rest envelope with node:crypto, byte-compatible with the
 * implementation (pinned by 7d G1): 'EMAPPENC'(8) | 0x01 | keyId 0x0001 |
 * iv(12) | tag(16) | AES-256-GCM ciphertext, key = base64-decoded
 * env DOC_ENCRYPTION_KEY, NO AAD.
 */
function encryptEnvelope(plain: Buffer): Buffer {
  const key = Buffer.from(process.env['DOC_ENCRYPTION_KEY']!, 'base64');
  expect(key.length, 'DOC_ENCRYPTION_KEY must base64-decode to 32 bytes').toBe(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(ENVELOPE_MAGIC, 'ascii'),
    Buffer.from([ENVELOPE_VERSION]),
    Buffer.from([0x00, 0x01]), // keyId slot 0x0001
    iv,
    tag,
    ciphertext,
  ]);
}

/**
 * Seed one sensitive doc row marked uploaded+clean+bytes_encrypted=true (SQL)
 * and plant `atRestBytes` directly into the Fake storage at its r2Key —
 * bypassing uploadContent so each test controls the EXACT at-rest object.
 */
async function seedEncryptedDoc(
  svc: DocumentsService,
  fake: FakeStorageProvider,
  atRestBytes: Buffer,
): Promise<string> {
  const created = await svc.create(payload(randomUUID()), sensitiveInput(PLAINTEXT));
  const id = created.document.id;
  await markUploadedCleanEncrypted(id);
  fake.objects.set(await docR2Key(id), atRestBytes);
  return id;
}

/** Valid-unlock download attempt; returns { thrown, result } for assertions. */
async function attemptDownload(
  svc: DocumentsService,
  id: string,
): Promise<{ thrown: unknown; result: unknown }> {
  const sid = await seedSession(managerId);
  await setUnlock(sid, 0); // freshly stamped unlock — the gate is NOT the subject here
  let thrown: unknown;
  let result: unknown;
  try {
    result = await svc.getDecryptedStream(payload(sid), id);
  } catch (e) {
    thrown = e;
  }
  return { thrown, result };
}

function expectDecryptFailed(thrown: unknown, result: unknown, what: string): void {
  expect(thrown, `${what} must reject the download`).toBeTruthy();
  expect(result, `${what} must return NO stream/bytes`).toBeUndefined();
  expect(errStatus(thrown), `${what} is a 500 (ops incident, not client-actionable)`).toBe(500);
  expect(errCode(thrown)).toBe(DECRYPT_FAILED);
}

beforeAll(async () => {
  await setupTestDatabase();
  // Same seeding contract as doc-encryption-7d.spec.ts: if Infisical dev does
  // not (yet) deliver DOC_ENCRYPTION_KEY, seed the documented TEST-ONLY value;
  // ??= keeps a real Infisical-delivered secret authoritative.
  process.env['DOC_ENCRYPTION_KEY'] ??= TEST_DOC_KEY_BYTES.toString('base64');
  reloadEnv(); // re-snapshot @emapp/db env in place (v8 §v7-C)
  const tag = `s7d-envrob-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 120_000);

// ───────────────────────────────────────────────────────────────────────────
// R) corrupted at-rest objects → 500 document_decrypt_failed, zero bytes out
// ───────────────────────────────────────────────────────────────────────────
describe('LOW-2 · R) malformed envelope at rest → document_decrypt_failed', () => {
  it('R1) wrong MAGIC (XXXXXXXX prefix on an otherwise-valid envelope) → 500 document_decrypt_failed', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake);
    const corrupted = Buffer.concat([
      Buffer.from('XXXXXXXX', 'ascii'),
      encryptEnvelope(PLAINTEXT).subarray(8),
    ]);
    const id = await seedEncryptedDoc(svc, fake, corrupted);
    const { thrown, result } = await attemptDownload(svc, id);
    expectDecryptFailed(thrown, result, 'a wrong-magic object');
  }, 40_000);

  it('R2) wrong VERSION byte (0x02) → 500 document_decrypt_failed', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake);
    const corrupted = Buffer.from(encryptEnvelope(PLAINTEXT)); // copy, then patch
    corrupted[8] = 0x02; // version byte right after the 8-byte magic
    const id = await seedEncryptedDoc(svc, fake, corrupted);
    const { thrown, result } = await attemptDownload(svc, id);
    expectDecryptFailed(thrown, result, 'an unknown-version envelope');
  }, 40_000);

  it(`R3) TRUNCATED object (20 bytes < ${ENVELOPE_HEADER_LEN}-byte header) → 500 document_decrypt_failed`, async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake);
    const corrupted = encryptEnvelope(PLAINTEXT).subarray(0, 20); // valid magic, no full header
    const id = await seedEncryptedDoc(svc, fake, corrupted);
    const { thrown, result } = await attemptDownload(svc, id);
    expectDecryptFailed(thrown, result, 'a truncated (sub-header) object');
  }, 40_000);

  it('R4) valid header, TAMPERED ciphertext (one flipped byte → GCM auth failure) → 500 document_decrypt_failed, no partial plaintext', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake);
    const tampered = Buffer.from(encryptEnvelope(PLAINTEXT)); // genuine envelope, then flip
    tampered[ENVELOPE_HEADER_LEN] = tampered[ENVELOPE_HEADER_LEN]! ^ 0xff; // first ct byte
    const id = await seedEncryptedDoc(svc, fake, tampered);
    const { thrown, result } = await attemptDownload(svc, id);
    expectDecryptFailed(thrown, result, 'a tampered-ciphertext envelope');
    // GCM is authenticated: a tamper must never yield even PARTIAL plaintext,
    // and the error envelope must not echo any of it.
    const wire = JSON.stringify((thrown as HttpException).getResponse());
    expect(wire.includes('%PDF'), 'error body must not leak plaintext fragments').toBe(false);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// K) LOW-1 pin — key misconfig at DECRYPT surfaces as the ops 503, not the 500
// ───────────────────────────────────────────────────────────────────────────
describe('LOW-2 · K) key misconfig at decrypt → 503 doc_encryption_unavailable', () => {
  it('K1) DOC_ENCRYPTION_KEY unset at decrypt time → 503 doc_encryption_unavailable (NOT document_decrypt_failed)', async () => {
    const fake = new FakeStorageProvider();
    const svc = makeSvc(fake);
    // A PRISTINE, genuinely-decryptable envelope — only the key goes missing,
    // so any failure is attributable to the key fetch, not corruption.
    const id = await seedEncryptedDoc(svc, fake, encryptEnvelope(PLAINTEXT));

    const saved = process.env['DOC_ENCRYPTION_KEY'];
    let thrown: unknown;
    let result: unknown;
    try {
      delete process.env['DOC_ENCRYPTION_KEY'];
      reloadEnv(); // @emapp/db env snapshot now has DOC_ENCRYPTION_KEY undefined
      ({ thrown, result } = await attemptDownload(svc, id));
    } finally {
      process.env['DOC_ENCRYPTION_KEY'] = saved;
      reloadEnv(); // restore the snapshot for every later test/file in the worker
    }

    expect(thrown, 'a key misconfig must reject the download').toBeTruthy();
    expect(result, 'a key misconfig must return NO stream/bytes').toBeUndefined();
    // The LOW-1 fix: the key fetch is OUTSIDE the decrypt try/catch, so a
    // misconfig surfaces as the actionable ops 503 instead of being swallowed
    // into the generic 500 corruption code.
    expect(errStatus(thrown), 'key misconfig is the ops 503, not the 500').toBe(503);
    expect(errCode(thrown)).toBe(ENCRYPTION_UNAVAILABLE);
    expect(errCode(thrown)).not.toBe(DECRYPT_FAILED);

    // Sanity: with the key RESTORED the very same at-rest object decrypts —
    // proving K1's failure was purely the key misconfig (and leaving the env
    // healthy for subsequent specs).
    const after = await attemptDownload(svc, id);
    expect(after.thrown, 'restored key must decrypt the same object').toBeUndefined();
  }, 40_000);
});
