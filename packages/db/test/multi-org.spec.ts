import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '../src/client';
import { notifications } from '../src/schema/collaboration';
import { memberships, users } from '../src/schema/tenancy';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

describe('T1.7 — Multi-org user isolation', () => {
  let orgA: TestOrg;
  let orgB: TestOrg;
  let orgC: TestOrg;
  let sharedUserId: string;
  let notifId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    const ts = Date.now();
    orgA = await createTestOrg(`T17-OrgA-${ts}`, `t17-orga-${ts}`);
    orgB = await createTestOrg(`T17-OrgB-${ts}`, `t17-orgb-${ts}`);
    orgC = await createTestOrg(`T17-OrgC-${ts}`, `t17-orgc-${ts}`);

    const [user] = await db
      .insert(users)
      .values({
        email: `shared-${ts}@test.local`,
        name: 'Shared Multi-Org User',
        passwordHash: '$2b$12$placeholder',
      })
      .returning();
    sharedUserId = user!.id;

    await db.insert(memberships).values([
      {
        userId: sharedUserId,
        orgId: orgA.id,
        role: 'agent',
        isPrimary: false,
        acceptedAt: new Date(),
      },
      {
        userId: sharedUserId,
        orgId: orgB.id,
        role: 'agent',
        isPrimary: false,
        acceptedAt: new Date(),
      },
    ]);

    const client = await pool.connect();
    try {
      const result = await client.query<{ id: string }>(
        `INSERT INTO notifications (org_id, user_id, type, title, metadata)
         VALUES ($1, $2, 'task_assigned', 'T17 Test Notif', '{}')
         RETURNING id`,
        [orgA.id, sharedUserId],
      );
      notifId = result.rows[0]!.id;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('shared user is visible in orgA context (has membership)', async () => {
    const result = await withTenant(orgA.id, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.id, sharedUserId)),
    );
    expect(result).toHaveLength(1);
  });

  it('shared user is visible in orgB context (has membership)', async () => {
    const result = await withTenant(orgB.id, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.id, sharedUserId)),
    );
    expect(result).toHaveLength(1);
  });

  it('shared user is NOT visible in orgC context (no membership)', async () => {
    const result = await withTenant(orgC.id, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.id, sharedUserId)),
    );
    expect(result).toHaveLength(0);
  });

  it('notification from orgA is visible in orgA context', async () => {
    const result = await withTenant(
      orgA.id,
      (tx) =>
        tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, notifId)),
      { userId: sharedUserId },
    );
    expect(result).toHaveLength(1);
  });

  it('notification from orgA is NOT visible in orgB context', async () => {
    const result = await withTenant(
      orgB.id,
      (tx) =>
        tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, notifId)),
      { userId: sharedUserId },
    );
    expect(result).toHaveLength(0);
  });

  it('revoking orgA membership makes user invisible from orgA context', async () => {
    await db
      .update(memberships)
      .set({ revokedAt: new Date() })
      .where(and(eq(memberships.userId, sharedUserId), eq(memberships.orgId, orgA.id)));

    const result = await withTenant(orgA.id, (tx) =>
      tx.select({ id: users.id }).from(users).where(eq(users.id, sharedUserId)),
    );
    expect(result).toHaveLength(0);
  });
});
