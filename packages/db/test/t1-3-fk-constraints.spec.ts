import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';

import { setupTestDatabase } from './setup';

const FAKE_UUID = '00000000-0000-0000-0000-000000000099';

async function expectFkViolation(query: string, values: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expect(client.query(query, values)).rejects.toMatchObject({ code: '23503' });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

describe('T1.3 — Foreign key constraints enforced', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('project with non-existent org_id is rejected', async () => {
    await expectFkViolation(
      `INSERT INTO projects (org_id, name, type, status, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [FAKE_UUID, 'FK Test', 'tama38_1', 'planning', FAKE_UUID],
    );
  });

  it('building with non-existent project_id is rejected', async () => {
    await expectFkViolation(
      `INSERT INTO buildings (project_id, address, city) VALUES ($1, $2, $3)`,
      [FAKE_UUID, 'Test St 1', 'Tel Aviv'],
    );
  });

  it('task with non-existent org_id is rejected', async () => {
    await expectFkViolation(
      `INSERT INTO tasks (org_id, title, type, status, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [FAKE_UUID, 'FK Test Task', 'general', 'pending', 2, FAKE_UUID],
    );
  });

  it('owner with non-existent org_id is rejected', async () => {
    // v8 §v8-S3: owners.name moved to encrypted bytea + hash bytea
    // (migration 0033). Test inserts use the new columns directly;
    // the actual byte values don't matter for the FK-violation check.
    await expectFkViolation(
      `INSERT INTO owners (org_id, name_encrypted, name_hash, national_id_encrypted, national_id_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [FAKE_UUID, Buffer.from('enc-name'), Buffer.from('hash-name'), Buffer.from('enc'), 'hash'],
    );
  });

  it('membership with non-existent org_id is rejected', async () => {
    await expectFkViolation(
      `INSERT INTO memberships (user_id, org_id, role)
       VALUES ($1, $2, $3)`,
      [FAKE_UUID, FAKE_UUID, 'agent'],
    );
  });

  it('provider_audit_log with non-existent provider_user_id is rejected', async () => {
    await expectFkViolation(
      `INSERT INTO provider_audit_log (provider_user_id, reason, action_type, started_at)
       VALUES ($1, $2, $3, now())`,
      [FAKE_UUID, 'test reason', 'session'],
    );
  });
});
