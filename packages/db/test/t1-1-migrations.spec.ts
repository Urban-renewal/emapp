import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';

import { setupTestDatabase } from './setup';

const EXPECTED_TABLES = [
  'organizations',
  'users',
  'memberships',
  'projects',
  'buildings',
  'apartments',
  'owners',
  'ownerships',
  'contractors',
  'shares',
  'tasks',
  'task_assignees',
  'notifications',
  'project_assignments',
  'documents',
  'signatures',
  'notes',
  'audit_log',
  'provider_users',
  'provider_audit_log',
  'cache_kv',
];

const EXPECTED_ENUMS = [
  'apartment_status',
  'notification_type',
  'project_status',
  'project_type',
  'task_status',
  'user_role',
];

describe('T1.1 — Migrations run clean', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('all expected tables exist in public schema', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const names = result.rows.map((r) => r.table_name);
    for (const table of EXPECTED_TABLES) {
      expect(names, `table "${table}" should exist`).toContain(table);
    }
  });

  it('all expected enums exist', async () => {
    const result = await pool.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname`,
    );
    const enums = result.rows.map((r) => r.typname);
    for (const e of EXPECTED_ENUMS) {
      expect(enums, `enum "${e}" should exist`).toContain(e);
    }
  });

  it('drizzle has applied all migrations', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    const count = Number(result.rows[0]?.count ?? 0);
    expect(count).toBeGreaterThanOrEqual(9);
  });

  it('trigger_set_updated_at function exists', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_proc
       WHERE proname = 'trigger_set_updated_at'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });
});
