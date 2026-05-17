import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';
import { projects } from '../src/schema/projects';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

describe('T1.9 — withTenant rollback on exception', () => {
  let org: TestOrg;

  beforeAll(async () => {
    await setupTestDatabase();
    org = await createTestOrg(`T19-Org-${Date.now()}`, `t19-org-${Date.now()}`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls back inserts when fn throws', async () => {
    const uniqueName = `rollback-test-${Date.now()}`;

    await expect(
      withTenant(org.id, async (tx) => {
        await tx.insert(projects).values({
          orgId: org.id,
          name: uniqueName,
          type: 'tama38_1',
          createdBy: org.users[0]!.id,
        });
        throw new Error('intentional failure');
      }),
    ).rejects.toThrow('intentional failure');

    // Verify the insert was rolled back
    const result = await withTenant(org.id, async (tx) =>
      tx.select().from(projects).where(eq(projects.name, uniqueName)),
    );
    expect(result).toHaveLength(0);
  });

  it('throws synchronously for invalid orgId', async () => {
    await expect(withTenant('not-a-uuid', async () => ({ done: true }))).rejects.toThrow(
      'withTenant: orgId must be a valid UUID',
    );
  });

  it('throws synchronously for invalid userId option', async () => {
    await expect(
      withTenant(org.id, async () => ({ done: true }), { userId: 'not-a-uuid' }),
    ).rejects.toThrow('withTenant: userId must be a valid UUID');
  });
});
