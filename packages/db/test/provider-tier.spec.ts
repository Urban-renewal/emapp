import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool, providerPool } from '../src/client';
import { projects } from '../src/schema/projects';
import { withProvider } from '../src/wrappers/with-provider';
import { withTenant } from '../src/wrappers/with-tenant';

import {
  createTestOrg,
  createTestProviderUser,
  type TestOrg,
  type TestProviderUser,
} from './factories';
import { setupTestDatabase } from './setup';

describe('T1.6 — Provider tier access and audit', () => {
  let orgA: TestOrg;
  let orgB: TestOrg;
  let provider: TestProviderUser;

  beforeAll(async () => {
    await setupTestDatabase();
    orgA = await createTestOrg(`T16-OrgA-${Date.now()}`, `t16-orga-${Date.now()}`);
    orgB = await createTestOrg(`T16-OrgB-${Date.now()}`, `t16-orgb-${Date.now()}`);
    provider = await createTestProviderUser();
  });

  afterAll(async () => {
    await pool.end();
    await providerPool.end();
  });

  it('Scenario 1: withProvider sees projects from all orgs (bypasses RLS)', async () => {
    const allProjects = await withProvider(
      provider.id,
      'Testing cross-org read access',
      async (tx) => tx.select({ id: projects.id, orgId: projects.orgId }).from(projects),
    );

    const orgIds = allProjects.map((p) => p.orgId);
    expect(orgIds).toContain(orgA.id);
    expect(orgIds).toContain(orgB.id);
  });

  it('Scenario 2: every withProvider call writes an audit log entry', async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM provider_audit_log WHERE provider_user_id = $1`,
      [provider.id],
    );
    const countBefore = Number(before.rows[0]!.count);

    await withProvider(provider.id, 'Audit trail verification test', async () => 'done');

    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM provider_audit_log WHERE provider_user_id = $1`,
      [provider.id],
    );
    const countAfter = Number(after.rows[0]!.count);
    expect(countAfter).toBe(countBefore + 1);
  });

  it('Scenario 3: provider_app_role cannot UPDATE or DELETE provider_audit_log', async () => {
    const result = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'provider_audit_log' AND grantee = 'provider_app_role'`,
    );
    const privileges = result.rows.map((r) => r.privilege_type);
    expect(privileges).not.toContain('UPDATE');
    expect(privileges).not.toContain('DELETE');
  });

  it('Scenario 4: withProvider rejects empty reason', async () => {
    await expect(withProvider(provider.id, '', async () => 'done')).rejects.toThrow(
      'withProvider: reason is required',
    );
  });

  it('Scenario 4: withProvider rejects whitespace-only reason', async () => {
    await expect(withProvider(provider.id, '    ', async () => 'done')).rejects.toThrow(
      'withProvider: reason is required',
    );
  });

  it('Scenario 4: withProvider rejects reason shorter than 5 chars', async () => {
    await expect(withProvider(provider.id, 'hi', async () => 'done')).rejects.toThrow(
      'withProvider: reason is required',
    );
  });

  it('Scenario 5: app_user (withTenant) still subject to RLS — cannot see other org', async () => {
    const orgAProjects = await withTenant(orgA.id, (tx) =>
      tx.select({ id: projects.id, orgId: projects.orgId }).from(projects),
    );
    const orgIds = orgAProjects.map((p) => p.orgId);
    expect(orgIds.every((id) => id === orgA.id)).toBe(true);
    expect(orgIds).not.toContain(orgB.id);
  });
});
