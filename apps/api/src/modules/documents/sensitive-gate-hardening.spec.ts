/**
 * S7b-OTP security-review HIGH fixes — locking tests.
 *
 * HIGH-1: PATCH /documents/:id retyping a doc TO a sensitive type
 *         (id_document/financial) must re-derive sensitive=true (turn-ON-only),
 *         else upload-as-'other' → PATCH-to-'id_document' bypasses the step-up
 *         gate entirely.
 * HIGH-2: the EXTERNAL contractor tier has no OTP step-up session, so sensitive
 *         documents are NEVER listed nor served to it (fail-closed exclusion,
 *         404 no-oracle on download).
 *
 * Harness mirrors documents-scan-gate.spec.ts (real DB, providerPool seeding).
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { reloadEnv, type IStorageProvider } from '@emapp/db';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { DocumentsService } from './documents.service';

const pool = () => providerPool;

// Gate-6: a PATCH that flips a doc sensitive RE-ENCRYPTS its plaintext object in
// place, so update() needs DOC_ENCRYPTION_KEY. CI / Infisical dev don't deliver
// it yet — seed the documented TEST-ONLY 32-byte value (??= keeps a real secret
// authoritative) so the encrypt registry resolves a key instead of 503-ing.
const TEST_DOC_KEY_B64 = Buffer.from('emapp-7d-test-doc-key-32bytes!!!').toString('base64');
function seedDocEncryptionKey(): void {
  process.env['DOC_ENCRYPTION_KEY'] ??= TEST_DOC_KEY_B64;
  reloadEnv();
}

/** Stub storage returning PLAINTEXT source bytes so the Gate-6 in-place
 *  re-encrypt that runs when update() flips a doc sensitive can read → envelope
 *  → putObject (a no-op here). The specs assert DB-level sensitive flips. */
class StubStorage implements IStorageProvider {
  async getUploadUrl(): Promise<string> {
    return 'https://r2.example.test/put';
  }
  async getDownloadUrl(): Promise<string> {
    return 'https://r2.example.test/get';
  }
  async delete(): Promise<void> {}
  async head(): Promise<null> {
    return null;
  }
  async putObject(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    return Readable.from([Buffer.from('%PDF-1.4 plaintext doc bytes %%EOF')]);
  }
  async healthCheck(): Promise<void> {}
}
const stubStorage = new StubStorage();
const makeDocsSvc = () => new DocumentsService(stubStorage, undefined as never, undefined as never);

function manager(org: TestOrg): AccessTokenPayload {
  return {
    sub: org.users.find((u) => u.role === 'manager')!.id,
    orgId: org.id,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as AccessTokenPayload;
}

async function seedDoc(org: TestOrg, opts: { type: string; sensitive?: boolean }) {
  const id = randomUUID();
  const sensitive = opts.sensitive ?? false;
  await pool().query(
    // A STORED sensitive doc (uploaded_at set) is encrypted at rest by the
    // Gate-6 invariant (0080 CHECK + 0081 reject-on-insert trigger), so
    // bytes_encrypted tracks sensitive here. Storage is stubbed in these tests —
    // only the DB flags drive the behavior under test.
    `INSERT INTO documents (id, org_id, project_id, apartment_id, name, type, mime_type,
       size_bytes, content_hash, r2_key, uploaded_by, uploaded_at, scan_status, sensitive, bytes_encrypted)
     VALUES ($1, $2, $3, NULL, 'hardening doc', $4, 'application/pdf',
       100, 'h', $5, $6, now(), 'clean', $7, $8)`,
    [
      id,
      org.id,
      org.projects[0]!.id,
      opts.type,
      `t/${id}`,
      org.users.find((u) => u.role === 'manager')!.id,
      sensitive,
      sensitive,
    ],
  );
  return id;
}

describe('S7b hardening — sensitive turn-ON via PATCH (HIGH-1)', () => {
  let org: TestOrg;
  beforeAll(async () => {
    await setupTestDatabase();
    seedDocEncryptionKey();
    org = await createTestOrg(`s7b-hard1-${Date.now()}`);
  });
  /* shared pools; global teardown closes them */

  it('PATCH type → id_document re-derives sensitive=true', async () => {
    const svc = makeDocsSvc();
    const docId = await seedDoc(org, { type: 'other', sensitive: false });
    await svc.update(manager(org), docId, { type: 'id_document' });
    const { rows } = await pool().query(`SELECT sensitive FROM documents WHERE id = $1`, [docId]);
    expect(rows[0]?.sensitive).toBe(true);
  });

  it('PATCH type → land_registry (נסח טאבו) re-derives sensitive=true', async () => {
    // A land-registry extract lists every owner's national_id, so the doc_type
    // alone must turn sensitive ON (encrypt-at-rest + OTP + contractor-exclude),
    // exactly like id_document/financial. Guards the #1 live PII leak.
    const svc = makeDocsSvc();
    const docId = await seedDoc(org, { type: 'other', sensitive: false });
    await svc.update(manager(org), docId, { type: 'land_registry' });
    const { rows } = await pool().query(`SELECT sensitive FROM documents WHERE id = $1`, [docId]);
    expect(rows[0]?.sensitive).toBe(true);
  });

  it('PATCH name only does NOT flip sensitive (no accidental ON, never OFF)', async () => {
    const svc = makeDocsSvc();
    const plain = await seedDoc(org, { type: 'other', sensitive: false });
    await svc.update(manager(org), plain, { name: 'renamed' });
    const a = await pool().query(`SELECT sensitive FROM documents WHERE id = $1`, [plain]);
    expect(a.rows[0]?.sensitive).toBe(false);

    const hot = await seedDoc(org, { type: 'id_document', sensitive: true });
    await svc.update(manager(org), hot, { name: 'renamed too', type: 'other' });
    const b = await pool().query(`SELECT sensitive FROM documents WHERE id = $1`, [hot]);
    // turn-ON-only: retyping AWAY from a sensitive type never clears the flag.
    expect(b.rows[0]?.sensitive).toBe(true);
  });
});

describe('S7b hardening — contractor tier excludes sensitive docs (HIGH-2)', () => {
  let org: TestOrg;
  beforeAll(async () => {
    await setupTestDatabase();
    org = await createTestOrg(`s7b-hard2-${Date.now()}`);
  });
  /* shared pools; global teardown closes them */

  async function loadContractorService() {
    const mod = await import('../contractor-portal/contractor-read.service');
    return mod;
  }

  function ctx(o: TestOrg) {
    return {
      orgId: o.id,
      projectId: o.projects[0]!.id,
      shareId: randomUUID(),
      permissions: {
        overview: { on: true },
        documents: { on: true, actions: { download: true } },
        signatures: { on: false },
      },
    };
  }

  it('a sensitive project doc is NOT listed and its download 404s (no-oracle)', async () => {
    const { ContractorReadService } = await loadContractorService();
    const sensitiveId = await seedDoc(org, { type: 'financial', sensitive: true });
    const plainId = await seedDoc(org, { type: 'blueprint', sensitive: false });

    const storageStub = {
      getDownloadUrl: async () => 'https://r2.example/url',
    };
    const svc = new ContractorReadService(storageStub as never);

    const list = await svc.getDocuments(ctx(org) as never);
    const ids = list.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(plainId);
    expect(ids).not.toContain(sensitiveId);

    await expect(svc.getDownloadUrl(ctx(org) as never, sensitiveId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
    const ok = await svc.getDownloadUrl(ctx(org) as never, plainId);
    expect(ok.url).toBeTruthy();
  });

  it('a sensitive land_registry (נסח טאבו) project doc is NOT listed/served to a contractor', async () => {
    // The council's named fix: a tabu extract — most PII-dense doc in the system —
    // must be structurally excluded from the non-sensitive contractor share tier.
    const { ContractorReadService } = await loadContractorService();
    const tabuId = await seedDoc(org, { type: 'land_registry', sensitive: true });
    const svc = new ContractorReadService({
      getDownloadUrl: async () => 'https://r2.example/url',
    } as never);

    const list = await svc.getDocuments(ctx(org) as never);
    expect(list.data.map((d: { id: string }) => d.id)).not.toContain(tabuId);

    await expect(svc.getDownloadUrl(ctx(org) as never, tabuId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  });
});
