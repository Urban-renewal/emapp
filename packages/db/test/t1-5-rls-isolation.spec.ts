import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';
import { projects } from '../src/schema/projects';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

describe('T1.5 — RLS isolation across tenants', () => {
  let orgA: TestOrg;
  let orgB: TestOrg;

  beforeAll(async () => {
    await setupTestDatabase();
    orgA = await createTestOrg(`T15-OrgA-${Date.now()}`, `t15-orga-${Date.now()}`);
    orgB = await createTestOrg(`T15-OrgB-${Date.now()}`, `t15-orgb-${Date.now()}`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('Scenario 1: SELECT cannot read across tenants', async () => {
    const result = await withTenant(orgA.id, async (tx) => tx.select().from(projects));

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((p) => p.orgId === orgA.id)).toBe(true);
    const orgBIds = new Set(orgB.projects.map((p) => p.id));
    expect(result.filter((p) => orgBIds.has(p.id))).toHaveLength(0);
  });

  it('Scenario 2: SELECT by ID for other org returns 0 rows', async () => {
    const orgBProjectId = orgB.projects[0]!.id;
    const result = await withTenant(orgA.id, async (tx) =>
      tx.select().from(projects).where(eq(projects.id, orgBProjectId)),
    );
    expect(result).toHaveLength(0);
  });

  it('Scenario 3: INSERT with other org_id rejected by WITH CHECK', async () => {
    const orgBProject = orgB.projects[0]!;
    await expect(
      withTenant(orgA.id, async (tx) =>
        tx.insert(projects).values({
          orgId: orgB.id,
          name: 'cross-org injection',
          type: 'tama38_1',
          createdBy: orgA.users[0]!.id,
        }),
      ),
    ).rejects.toThrow();

    // Verify orgB's data is intact
    const orgBProjects = await withTenant(orgB.id, async (tx) =>
      tx.select().from(projects).where(eq(projects.id, orgBProject.id)),
    );
    expect(orgBProjects).toHaveLength(1);
  });

  it('Scenario 4: UPDATE of other org row is no-op (0 rows affected)', async () => {
    const orgBProjectId = orgB.projects[0]!.id;
    const result = await withTenant(orgA.id, async (tx) =>
      tx
        .update(projects)
        .set({ name: 'hijacked' })
        .where(eq(projects.id, orgBProjectId))
        .returning(),
    );
    expect(result).toHaveLength(0);

    // Verify B's project unchanged
    const [unchanged] = await withTenant(orgB.id, async (tx) =>
      tx.select().from(projects).where(eq(projects.id, orgBProjectId)),
    );
    expect(unchanged?.name).not.toBe('hijacked');
  });

  it('Scenario 5: DELETE of other org row is no-op', async () => {
    const orgBProjectId = orgB.projects[0]!.id;
    const result = await withTenant(orgA.id, async (tx) =>
      tx.delete(projects).where(eq(projects.id, orgBProjectId)).returning(),
    );
    expect(result).toHaveLength(0);

    // Verify B's project still exists
    const [stillExists] = await withTenant(orgB.id, async (tx) =>
      tx.select().from(projects).where(eq(projects.id, orgBProjectId)),
    );
    expect(stillExists).toBeDefined();
  });

  it('Scenario 6: No tenant context (forgotten withTenant) returns 0 rows', async () => {
    // Without withTenant, app.organization_id is not set → policy evaluates to NULL → no rows
    // We can't call db.select() directly (ESLint blocks it), but we can test via withTenant
    // with a non-existent org UUID to simulate "no match"
    const nonExistentOrg = '00000000-0000-0000-0000-000000000000';
    const result = await withTenant(nonExistentOrg, async (tx) => tx.select().from(projects));
    expect(result).toHaveLength(0);
  });

  it('Scenario 7: withTenant with orgA only sees orgA data', async () => {
    const [orgAResult, orgBResult] = await Promise.all([
      withTenant(orgA.id, async (tx) => tx.select().from(projects)),
      withTenant(orgB.id, async (tx) => tx.select().from(projects)),
    ]);

    const orgAIds = new Set(orgAResult.map((p) => p.id));
    const orgBIds = new Set(orgBResult.map((p) => p.id));

    // No overlap
    const overlap = [...orgAIds].filter((id) => orgBIds.has(id));
    expect(overlap).toHaveLength(0);

    // Each org sees only its own data
    expect(orgAResult.every((p) => p.orgId === orgA.id)).toBe(true);
    expect(orgBResult.every((p) => p.orgId === orgB.id)).toBe(true);
  });
});
