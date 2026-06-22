/**
 * Gate-6 REGRESSION — the sensitive-doc-at-rest fail-close, on BOTH serving
 * surfaces. Authored as an independent guard for the launch-blocker fixed by the
 * 0080 CHECK + B1 (resolveDownload) + B4 (public-sign preview):
 *
 *   A `sensitive && !bytes_encrypted && uploaded` document (national_id / נסח PII
 *   sitting PLAINTEXT in R2) must NEVER be plain-presigned. Both serving paths
 *   FAIL CLOSED:
 *     - B1  DocumentsService.resolveDownload → 503 `doc_encryption_pending`
 *           (NEVER a presign; storage.getDownloadUrl is NOT called).
 *     - B4  PublicSignService.preview (the UNAUTHENTICATED resident surface) →
 *           generic 401 invalid_token (NEVER a presign).
 *   And the happy path still works: a `sensitive && bytes_encrypted` doc serves
 *   via the API DECRYPT-STREAM (B1) / the token-scoped stream URL (B4) — never a
 *   raw R2 presigned URL.
 *
 * The legacy `sensitive && !bytes_encrypted && uploaded` pre-state can no longer
 * be INSERTed directly (the 0081 BEFORE-INSERT trigger REJECTS it). We reproduce
 * it the sanctioned way — `SET LOCAL session_replication_role = replica` for that
 * one fixture insert (skips the trigger), exactly as a pre-0080 production row
 * looked.
 *
 * Real-DB, in-process service harness (mirrors doc-encryption-7d.spec).
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/sensitive-doc-failclose.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  FakeStorageProvider,
  NoopFileScanProvider,
  encryptOwnerPii,
  owners,
  reloadEnv,
  withTenant,
} from '@emapp/db';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';
import { PublicSignService } from '../signatures/public-sign.service';
import { SignatureTokenService } from '../signatures/signature-token.service';

import { DocumentsService } from './documents.service';

// TEST-ONLY 32-byte key (NOT a credential) → 44-char base64; same shape env.ts
// enforces for DOC_ENCRYPTION_KEY. Built from a readable literal so the
// secret-scanner doesn't false-positive.
const TEST_DOC_KEY = Buffer.from('emapp-g6-failclose-doc-key-32byt').toString('base64');
const SIGN_SECRET = Buffer.from('emapp-g6-failclose-signing-token-secret-48bytes!').toString(
  'base64url',
);

let org: TestOrg;
let managerId: string;
let projectId: string;
let ownerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000f1';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function errCode(e: unknown): string | undefined {
  if (e instanceof HttpException) {
    const body = e.getResponse() as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

/** Build the EMAPPENC envelope via the SAME service path the API uses, so the
 *  stream-path fixture's at-rest bytes are byte-identical to production. */
function makeDocs(storage: FakeStorageProvider): DocumentsService {
  return new DocumentsService(
    storage,
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
}

function envelopeFor(storage: FakeStorageProvider, plain: Buffer): Buffer {
  // (DocumentsService.encryptEnvelope is private; reach it the same controlled
  //  way the 7d spec reaches private members — via the instance.)
  const svc = makeDocs(storage) as unknown as { encryptEnvelope(b: Buffer): Buffer };
  return svc.encryptEnvelope(plain);
}

const CHECK_NAME = 'documents_sensitive_encrypted_at_rest';

/** Seed a document row. `legacyPlaintext` recreates the EXACT pre-0080
 *  `sensitive && !bytes_encrypted && uploaded` legacy state — a row that can no
 *  longer be written normally (the 0080 CHECK + 0081 trigger forbid it). We do
 *  it the way a real pre-constraint row exists in production: drop the CHECK,
 *  insert under `session_replication_role=replica` (skips the 0081 reject
 *  trigger), then re-add the CHECK `NOT VALID` (new writes guarded, the legacy
 *  row grandfathered — exactly the production posture pre-backfill). */
async function seedDoc(opts: {
  type: string;
  sensitive: boolean;
  bytesEncrypted: boolean;
  uploaded: boolean;
  legacyPlaintext?: boolean;
}): Promise<{ id: string; r2Key: string }> {
  const r2Key = `org/${org.id}/doc/${randomUUID()}`;
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    if (opts.legacyPlaintext) {
      await c.query(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
      await c.query("SET LOCAL session_replication_role = 'replica'");
    }
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, content_hash,
          r2_key, uploaded_by, uploaded_at, scan_status, sensitive, bytes_encrypted)
       VALUES ($1, $2, 'נסח טאבו.pdf', $3, 'application/pdf', 100, 'h',
          $4, $5, ${opts.uploaded ? 'now()' : 'NULL'}, 'clean', $6, $7)
       RETURNING id`,
      [org.id, projectId, opts.type, r2Key, managerId, opts.sensitive, opts.bytesEncrypted],
    );
    if (opts.legacyPlaintext) {
      await c.query("SET LOCAL session_replication_role = 'origin'");
      await c.query(
        `ALTER TABLE documents ADD CONSTRAINT ${CHECK_NAME} ` +
          `CHECK (NOT (sensitive AND uploaded_at IS NOT NULL AND NOT bytes_encrypted)) NOT VALID`,
      );
    }
    await c.query('COMMIT');
    return { id: r.rows[0]!.id, r2Key };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function seedSession(): Promise<void> {
  // A fresh PII step-up unlock on the manager's session so the sensitive-doc
  // gate's freshness check passes (the fail-close under test is at-rest
  // encryption, NOT the OTP gate).
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, pii_unlocked_at)
       VALUES ($1, $2, $3, now() + interval '30 days', now())`,
      [MGR_SID, managerId, `g6-failclose-${randomUUID()}`],
    );
  } finally {
    c.release();
  }
}

async function seedSignatureRequest(documentId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'pending', now() + interval '2 days', $5) RETURNING id`,
      [org.id, documentId, ownerId, 'jti-seed-' + randomUUID(), managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Mint a valid signing token for a seeded request and align the row's jti to it
 *  (the token's jti is server-generated, exactly like create/resend). */
async function tokenFor(requestId: string, documentId: string): Promise<string> {
  const tokenSvc = new SignatureTokenService(new JwtService(), SIGN_SECRET);
  const { token, jti } = tokenSvc.sign({
    sub: requestId,
    orgId: org.id,
    documentId,
    ownerId,
  });
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE signature_requests SET jti = $1 WHERE id = $2`, [jti, requestId]);
  } finally {
    c.release();
  }
  return token;
}

function makePublicSign(storage: FakeStorageProvider): PublicSignService {
  return new PublicSignService(
    new SignatureTokenService(new JwtService(), SIGN_SECRET),
    storage,
    emailStub,
    new NotificationsProducerService(),
  );
}

beforeAll(async () => {
  process.env['DOC_ENCRYPTION_KEY'] = TEST_DOC_KEY;
  process.env['SIGNATURE_TOKEN_SECRET'] = SIGN_SECRET;
  reloadEnv();
  await setupTestDatabase();

  org = await createTestOrg('g6-failclose');
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  ownerId = await withTenant(org.id, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: '123456782',
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: org.id,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `owner-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
  await seedSession();
});

describe('Gate-6 · B1 — DocumentsService.resolveDownload fail-close', () => {
  it('sensitive && !bytes_encrypted && uploaded → 503 doc_encryption_pending, NEVER a presign', async () => {
    const storage = new FakeStorageProvider();
    const docs = makeDocs(storage);
    const doc = await seedDoc({
      type: 'land_registry',
      sensitive: true,
      bytesEncrypted: false,
      uploaded: true,
      legacyPlaintext: true, // recreate the legacy plaintext-at-rest pre-state
    });
    // The plaintext bytes ARE present at rest (the dangerous state).
    storage.setObject(doc.r2Key, Buffer.from('%PDF-1.4 plaintext נסח PII %%EOF'));

    let thrown: unknown;
    try {
      await docs.resolveDownload(manager(), doc.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a sensitive plaintext doc was served — leak!').toBeTruthy();
    expect(errStatus(thrown)).toBe(503);
    expect(errCode(thrown)).toBe('doc_encryption_pending');
    // THE load-bearing assertion: no presigned URL was EVER minted for it.
    expect(storage.downloaded, 'a presign was minted for a sensitive plaintext doc').toEqual([]);
  });

  it('sensitive && bytes_encrypted → API decrypt-STREAM (kind:stream), never a presign', async () => {
    const storage = new FakeStorageProvider();
    const docs = makeDocs(storage);
    const plain = Buffer.from('%PDF-1.4 the real נסח %%EOF');
    const doc = await seedDoc({
      type: 'land_registry',
      sensitive: true,
      bytesEncrypted: true,
      uploaded: true,
    });
    // Store the ENVELOPE at rest (what a properly-encrypted object holds).
    storage.setObject(doc.r2Key, envelopeFor(storage, plain));

    const res = await docs.resolveDownload(manager(), doc.id);
    expect(res.kind).toBe('stream');
    expect(storage.downloaded, 'a sensitive encrypted doc must stream, not presign').toEqual([]);
  });

  it('NON-sensitive doc → presign path unchanged (byte-identical regression)', async () => {
    const storage = new FakeStorageProvider();
    const docs = makeDocs(storage);
    const doc = await seedDoc({
      type: 'blueprint',
      sensitive: false,
      bytesEncrypted: false,
      uploaded: true,
    });
    storage.setObject(doc.r2Key, Buffer.from('%PDF plain blueprint'));
    const res = await docs.resolveDownload(manager(), doc.id);
    expect(res.kind).toBe('presign');
    expect(storage.downloaded.length).toBe(1);
  });
});

describe('Gate-6 · B4 — PublicSignService.preview fail-close (unauthenticated surface)', () => {
  it('sensitive && !bytes_encrypted → generic invalid_token, NEVER a presign', async () => {
    const storage = new FakeStorageProvider();
    const publicSign = makePublicSign(storage);
    const doc = await seedDoc({
      type: 'land_registry',
      sensitive: true,
      bytesEncrypted: false,
      uploaded: true,
      legacyPlaintext: true,
    });
    storage.setObject(doc.r2Key, Buffer.from('%PDF plaintext נסח PII'));
    const requestId = await seedSignatureRequest(doc.id);
    const token = await tokenFor(requestId, doc.id);

    let thrown: unknown;
    try {
      await publicSign.preview(token, { ip: '1.2.3.4', userAgent: 'jest' });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      'an unauthenticated resident was served sensitive PLAINTEXT — leak!',
    ).toBeTruthy();
    expect(errStatus(thrown)).toBe(401);
    expect(errCode(thrown)).toBe('invalid_token');
    expect(storage.downloaded, 'a presign was minted on the public surface').toEqual([]);
  });

  it('sensitive && bytes_encrypted → downloadUrl is the token-scoped STREAM route, never a raw R2 presign', async () => {
    const storage = new FakeStorageProvider();
    const publicSign = makePublicSign(storage);
    const plain = Buffer.from('%PDF the real נסח %%EOF');
    const doc = await seedDoc({
      type: 'land_registry',
      sensitive: true,
      bytesEncrypted: true,
      uploaded: true,
    });
    storage.setObject(doc.r2Key, envelopeFor(storage, plain));
    const requestId = await seedSignatureRequest(doc.id);
    const token = await tokenFor(requestId, doc.id);

    const preview = await publicSign.preview(token, {
      ip: '1.2.3.4',
      userAgent: 'jest',
    });
    const downloadUrl = preview.document.downloadUrl;

    // The URL points at the API stream route, carrying the token — NOT the
    // FakeStorage raw presign (which would be https://fake-storage.test/...).
    expect(downloadUrl).toContain(`/api/v1/sign/`);
    expect(downloadUrl).toContain('/document');
    expect(downloadUrl).not.toContain('fake-storage.test');
    expect(storage.downloaded, 'no raw R2 presign for a sensitive encrypted doc').toEqual([]);
  });
});
