import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';

import { setupTestDatabase } from './setup';

const TENANT_TABLES = [
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
];

describe('T1.2 — All multi-tenant tables have RLS + FORCE', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('all tenant tables have row security enabled', async () => {
    const result = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind = 'r'`,
      [TENANT_TABLES],
    );
    const byName = Object.fromEntries(result.rows.map((r) => [r.relname, r]));
    for (const table of TENANT_TABLES) {
      expect(byName[table]?.relrowsecurity, `${table} should have RLS enabled`).toBe(true);
    }
  });

  it('all tenant tables have FORCE row security', async () => {
    const result = await pool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind = 'r'`,
      [TENANT_TABLES],
    );
    const byName = Object.fromEntries(result.rows.map((r) => [r.relname, r]));
    for (const table of TENANT_TABLES) {
      expect(byName[table]?.relforcerowsecurity, `${table} should have FORCE RLS`).toBe(true);
    }
  });

  it('every tenant table has a tenant_isolation policy', async () => {
    const result = await pool.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    const tablesWithPolicy = new Set(result.rows.map((r) => r.tablename));
    for (const table of TENANT_TABLES) {
      expect(tablesWithPolicy, `${table} should have a tenant_isolation policy`).toContain(table);
    }
  });

  it('provider tables do not have RLS (protected by grants only)', async () => {
    const result = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('provider_users', 'provider_audit_log') AND relkind = 'r'`,
    );
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} should not have RLS`).toBe(false);
    }
  });

  it('provider_app_role has only SELECT+INSERT on provider_audit_log (no UPDATE/DELETE)', async () => {
    const result = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'provider_audit_log' AND grantee = 'provider_app_role'`,
    );
    const privileges = result.rows.map((r) => r.privilege_type);
    expect(privileges).toContain('INSERT');
    expect(privileges).toContain('SELECT');
    expect(privileges).not.toContain('UPDATE');
    expect(privileges).not.toContain('DELETE');
  });

  it('app_user has no grants on provider tables', async () => {
    const result = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_name IN ('provider_users', 'provider_audit_log') AND grantee = 'app_user'`,
    );
    expect(result.rows).toHaveLength(0);
  });
});
