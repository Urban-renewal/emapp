import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';

import { createTestOrg } from './factories';
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
  let validOrgId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    // A real org is needed for tests that require valid org_id but fake project/building IDs.
    // Without a valid org_id, the org FK fires before the intended FK, masking the test.
    const org = await createTestOrg(`T13-Org-${Date.now()}`, `t13-org-${Date.now()}`);
    validOrgId = org.id;
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
    // org_id is valid so only the project_id FK fires (code 23503).
    await expectFkViolation(
      `INSERT INTO buildings (org_id, project_id, address, city) VALUES ($1, $2, $3, $4)`,
      [validOrgId, FAKE_UUID, 'Test St 1', 'Tel Aviv'],
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
    await expectFkViolation(
      `INSERT INTO owners (org_id, name, national_id_encrypted, national_id_hash)
       VALUES ($1, $2, $3, $4)`,
      [FAKE_UUID, 'Test Owner', Buffer.from('enc'), 'hash'],
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
