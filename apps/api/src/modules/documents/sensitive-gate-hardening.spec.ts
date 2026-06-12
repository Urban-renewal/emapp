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

import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { DocumentsService } from './documents.service';

const pool = () => providerPool;

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
  await pool().query(
    `INSERT INTO documents (id, org_id, project_id, apartment_id, name, type, mime_type,
       size_bytes, content_hash, r2_key, uploaded_by, uploaded_at, scan_status, sensitive)
     VALUES ($1, $2, $3, NULL, 'hardening doc', $4, 'application/pdf',
       100, 'h', $5, $6, now(), 'clean', $7)`,
    [
      id,
      org.id,
      org.projects[0]!.id,
      opts.type,
      `t/${id}`,
      org.users.find((u) => u.role === 'manager')!.id,
      opts.sensitive ?? false,
    ],
  );
  return id;
}

describe('S7b hardening — sensitive turn-ON via PATCH (HIGH-1)', () => {
  let org: TestOrg;
  beforeAll(async () => {
    await setupTestDatabase();
    org = await createTestOrg(`s7b-hard1-${Date.now()}`);
  });
  /* shared pools; global teardown closes them */

  it('PATCH type → id_document re-derives sensitive=true', async () => {
    const svc = new DocumentsService(
      // storage/scanner/notifications are not touched by update()
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const docId = await seedDoc(org, { type: 'other', sensitive: false });
    await svc.update(manager(org), docId, { type: 'id_document' });
    const { rows } = await pool().query(`SELECT sensitive FROM documents WHERE id = $1`, [docId]);
    expect(rows[0]?.sensitive).toBe(true);
  });

  it('PATCH name only does NOT flip sensitive (no accidental ON, never OFF)', async () => {
    const svc = new DocumentsService(undefined as never, undefined as never, undefined as never);
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
});
