/**
 * NotificationsService — whole-set-view contract (server `type` filter +
 * constant-time unread-count) against the REAL local DB.
 *
 * The RLS policy on `notifications` (org_id = app.organization_id AND user_id =
 * app.user_id) means seeding + reading both run as the same user via
 * `withTenant(orgId, …, { userId })`. This proves the additive `type` filter and
 * the `unreadCount` aggregate against actual rows — the FE relies on BOTH being
 * truthful at scale (the bell badge + page header show the real unread total;
 * a `?type=` filter narrows the whole org, not a 25-row client slice).
 *
 * THE CONTRACT under test:
 *  - list() with NO type → every seeded row, newest-first, keyset-paginated.
 *  - list({ type }) → ONLY that type, ACROSS pages (limit=1 still returns the
 *    next match — proving the filter is server-side, not a page-local slice).
 *  - list({ type }) for a type with zero rows → empty page.
 *  - unreadCount() → the TRUE count of read_at IS NULL rows (not a page count);
 *    marking one read decrements it; mark-all zeroes it.
 *  - RLS isolation: user-B never sees user-A's notifications or counts.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     pnpm --filter @emapp/api exec vitest run \
 *     src/modules/notifications/notifications.service.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, notifications, users, withTenant } from '@emapp/db';
import type { NotificationType } from '@emapp/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { NotificationsService } from './notifications.service';

let svc: NotificationsService;
let org: TestOrg;
let userAId: string;
let userBId: string;

const TAG = randomUUID().slice(0, 8);

function payload(userId: string): AccessTokenPayload {
  return {
    sub: userId,
    orgId: org.id,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Seed a notification as the given user (RLS WITH CHECK requires user_id =
 *  app.user_id, so the insert MUST run inside that user's tenant tx). */
async function seed(
  userId: string,
  type: NotificationType,
  read: boolean,
  createdAt: Date,
): Promise<void> {
  await withTenant(
    org.id,
    async (tx) => {
      await tx.insert(notifications).values({
        orgId: org.id,
        userId,
        type,
        title: `${TAG} ${type}`,
        body: null,
        link: '/x',
        metadata: {},
        readAt: read ? new Date() : null,
        createdAt,
      });
    },
    { userId },
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new NotificationsService();
  org = await createTestOrg(`notif-${TAG}`);

  // A second user in the SAME org, to prove RLS self-scoping.
  const [userB] = await db
    .insert(users)
    .values({
      email: `notif-b-${TAG}@test.local`,
      name: 'Notif B',
      passwordHash: '$2b$12$placeholder',
    })
    .returning();
  if (!userB) throw new Error('failed to create user B');
  userBId = userB.id;
  await db
    .insert(memberships)
    .values({ userId: userBId, orgId: org.id, role: 'manager', acceptedAt: new Date() });

  userAId = org.users[0]!.id;

  const base = Date.now();
  const at = (i: number): Date => new Date(base - i * 60_000); // newest-first by i
  // User A: 3 signature_received (2 unread), 2 task_assigned (1 unread),
  //         1 document_uploaded (read). Total 6 rows; unread = 2 + 1 = 3.
  await seed(userAId, 'signature_received', false, at(0));
  await seed(userAId, 'signature_received', false, at(1));
  await seed(userAId, 'signature_received', true, at(2));
  await seed(userAId, 'task_assigned', false, at(3));
  await seed(userAId, 'task_assigned', true, at(4));
  await seed(userAId, 'document_uploaded', true, at(5));
  // User B: 1 unread mention — must never appear in A's reads/counts.
  await seed(userBId, 'mention', false, at(0));
});

afterAll(async () => {
  // Best-effort cleanup of this run's rows (provider-pool bypass not needed —
  // delete as each owner). Non-fatal if it races other suites.
  for (const uid of [userAId, userBId]) {
    await withTenant(
      org.id,
      async (tx) => {
        await tx.delete(notifications);
      },
      { userId: uid },
    ).catch(() => undefined);
  }
});

describe('NotificationsService — server-side type filter + true unread-count', () => {
  it('list() with no type returns ALL of user A’s rows (6), newest-first', async () => {
    const page = await svc.list(payload(userAId), { limit: 50 });
    expect(page.data.length).toBe(6);
    // Newest-first: createdAt descending.
    for (let i = 1; i < page.data.length; i++) {
      expect(page.data[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        page.data[i]!.createdAt.getTime(),
      );
    }
  });

  it('list({ type }) narrows to that type ONLY (server-side, not a page slice)', async () => {
    const sig = await svc.list(payload(userAId), { limit: 50, type: 'signature_received' });
    expect(sig.data.length).toBe(3);
    expect(sig.data.every((n) => n.type === 'signature_received')).toBe(true);

    const tasks = await svc.list(payload(userAId), { limit: 50, type: 'task_assigned' });
    expect(tasks.data.length).toBe(2);
    expect(tasks.data.every((n) => n.type === 'task_assigned')).toBe(true);
  });

  it('list({ type }) keysets ACROSS pages — limit=1 still yields the next match', async () => {
    const p1 = await svc.list(payload(userAId), { limit: 1, type: 'signature_received' });
    expect(p1.data.length).toBe(1);
    expect(p1.page.has_more).toBe(true);
    expect(p1.page.cursor).not.toBeNull();
    const p2 = await svc.list(payload(userAId), {
      limit: 1,
      type: 'signature_received',
      cursor: p1.page.cursor!,
    });
    expect(p2.data.length).toBe(1);
    // Distinct row from page 1, still the SAME filtered type — proves the filter
    // composes with the keyset cursor (not a 25-row client slice that drops
    // matches past the first page).
    expect(p2.data[0]!.id).not.toBe(p1.data[0]!.id);
    expect(p2.data[0]!.type).toBe('signature_received');
  });

  it('list({ type }) for a zero-row type returns an empty page (no error)', async () => {
    const none = await svc.list(payload(userAId), { limit: 50, type: 'share_revoked' });
    expect(none.data.length).toBe(0);
    expect(none.page.has_more).toBe(false);
  });

  it('unreadCount() is the TRUE unread total (3), independent of any page size', async () => {
    const { count } = await svc.unreadCount(payload(userAId));
    expect(count).toBe(3);
  });

  it('marking one read decrements the true count; mark-all zeroes it', async () => {
    const before = (await svc.unreadCount(payload(userAId))).count;
    const firstUnread = (await svc.list(payload(userAId), { limit: 50 })).data.find(
      (n) => n.readAt === null,
    );
    expect(firstUnread).toBeDefined();
    await svc.markRead(payload(userAId), firstUnread!.id);
    expect((await svc.unreadCount(payload(userAId))).count).toBe(before - 1);

    const { updated } = await svc.markAllRead(payload(userAId));
    expect(updated).toBe(before - 1); // the rest of the unread rows
    expect((await svc.unreadCount(payload(userAId))).count).toBe(0);
  });

  it('RLS self-scoping: user B sees only THEIR own row + count (never user A’s)', async () => {
    const bList = await svc.list(payload(userBId), { limit: 50 });
    expect(bList.data.length).toBe(1);
    expect(bList.data[0]!.type).toBe('mention');
    expect((await svc.unreadCount(payload(userBId))).count).toBe(1);
  });
});
