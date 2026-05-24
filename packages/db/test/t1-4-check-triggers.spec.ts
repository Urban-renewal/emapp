import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

describe('T1.4 — CHECK constraints and immutable triggers', () => {
  let org: TestOrg;
  let taskOrgId: string;
  let taskCreatedBy: string;

  beforeAll(async () => {
    await setupTestDatabase();
    org = await createTestOrg(`T14-Org-${Date.now()}`, `t14-org-${Date.now()}`);
    taskOrgId = org.id;
    taskCreatedBy = org.users[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  // ─── tasks.priority CHECK (BETWEEN 1 AND 3) ────────────────────────────────

  it('task with priority=2 (valid) is accepted', async () => {
    const client = await pool.connect();
    try {
      const result = await client.query<{ id: string }>(
        `INSERT INTO tasks (org_id, title, type, status, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [taskOrgId, 'Valid Priority', 'general', 'pending', 2, taskCreatedBy],
      );
      expect(result.rows[0]?.id).toBeDefined();
    } finally {
      client.release();
    }
  });

  it('task with priority=0 (below range) is rejected', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO tasks (org_id, title, type, status, priority, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [taskOrgId, 'Bad Priority', 'general', 'pending', 0, taskCreatedBy],
        ),
      ).rejects.toMatchObject({ code: '23514' }); // check_violation
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('task with priority=5 (above range) is rejected', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO tasks (org_id, title, type, status, priority, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [taskOrgId, 'Bad Priority', 'general', 'pending', 5, taskCreatedBy],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ─── audit_log immutable trigger ───────────────────────────────────────────

  it('audit_log UPDATE is rejected by immutable trigger', async () => {
    const client = await pool.connect();
    try {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO audit_log (org_id, action, target_table, actor_type)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [taskOrgId, 'test_action', 'project', 'system'],
      );
      const id = ins.rows[0]?.id;
      await client.query('BEGIN');
      await expect(
        client.query(`UPDATE audit_log SET action = 'modified' WHERE id = $1`, [id]),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('audit_log DELETE is rejected by immutable trigger', async () => {
    const client = await pool.connect();
    try {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO audit_log (org_id, action, target_table, actor_type)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [taskOrgId, 'test_action', 'project', 'system'],
      );
      const id = ins.rows[0]?.id;
      await client.query('BEGIN');
      await expect(client.query(`DELETE FROM audit_log WHERE id = $1`, [id])).rejects.toThrow(
        /immutable/i,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  // ─── signatures immutable trigger ──────────────────────────────────────────

  it('signatures UPDATE is rejected by immutable trigger', async () => {
    const client = await pool.connect();
    try {
      // Spec model: signature → document + owner (+ forensic fields).
      // v8 §v8-S3: owners.name moved to name_encrypted + name_hash
      // (migration 0033). Encrypt the name inline via pgp_sym_encrypt
      // same way as national_id; hash with hmac to match the bytea
      // column type.
      const owner = await client.query<{ id: string }>(
        `INSERT INTO owners (org_id, name_encrypted, name_hash, national_id_encrypted, national_id_hash)
         VALUES (
           $1,
           pgp_sym_encrypt($2, $3),
           hmac($2::bytea, $4::bytea, 'sha256'),
           pgp_sym_encrypt($5, $3),
           $6
         ) RETURNING id`,
        [
          taskOrgId,
          'T14 Owner',
          'test-key',
          'test-hash-key',
          '123456789',
          `t14-natid-${Date.now()}`,
        ],
      );
      const ownerId = owner.rows[0]!.id;

      const doc = await client.query<{ id: string }>(
        `INSERT INTO documents (org_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          taskOrgId,
          'Signed Doc',
          'contract',
          'application/pdf',
          1024,
          `r2/t14/${Date.now()}`,
          'sha256-placeholder',
          taskCreatedBy,
        ],
      );
      const documentId = doc.rows[0]!.id;

      const sig = await client.query<{ id: string }>(
        `INSERT INTO signatures
           (org_id, document_id, owner_id, document_hash, signature_blob, auth_method, signed_at)
         VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
        [taskOrgId, documentId, ownerId, 'doc-hash', Buffer.from('fake-sig'), 'password'],
      );
      const sigId = sig.rows[0]!.id;

      await client.query('BEGIN');
      await expect(
        client.query(`UPDATE signatures SET signed_at = now() WHERE id = $1`, [sigId]),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
