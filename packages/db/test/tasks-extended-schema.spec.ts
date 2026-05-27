/**
 * V11 Track B.S5 — tasks-extended (scheduled_at + location) +
 * task_external_attendees schema invariants (migration 0036, D.38 + D.41).
 *
 * What this pins
 * ──────────────
 *   1) tasks.scheduled_at + location are nullable + additive (existing
 *      tasks still insert without them — back-compat).
 *   2) task_external_attendees Template B RLS via parent (task → org GUC).
 *   3) RLS WITH CHECK — Org B cannot insert an attendee for Org A's task.
 *   4) GRANT — app_user has no DELETE on task_external_attendees (soft
 *      cancel via ics_cancelled_at).
 *   5) UNIQUE (task_id, owner_id) — same owner can't be invited twice.
 *   6) Idempotency columns (ics_sent_at / ics_cancelled_at) round-trip
 *      via UPDATE (used by B.S7 Resend integration).
 *
 * Same pattern as building-sections-schema.spec.ts (B.S1).
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../src/client';
import { encryptOwnerPii } from '../src/helpers/owners';
import { owners, tasks } from '../src/schema';
import { taskExternalAttendees } from '../src/schema/collaboration';
import { withTenant } from '../src/wrappers/with-tenant';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

let orgA: TestOrg;
let orgB: TestOrg;
let taskAId: string;
let ownerAId: string;
let ownerA2Id: string;

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`B5A-${ts}`, `b5a-${ts}`);
  orgB = await createTestOrg(`B5B-${ts}`, `b5b-${ts}`);

  // Insert one task in org A (used as the parent for all attendee tests).
  taskAId = await withTenant(orgA.id, async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({
        orgId: orgA.id,
        title: 'Calendar parent task',
        createdBy: orgA.users[0]!.id,
      })
      .returning({ id: tasks.id });
    return row!.id;
  });

  // Two owners in org A (so we can test UNIQUE invariants + multi-attendee).
  // Use the prod helper so encryption GUC + hash key are both exercised.
  for (const [tag, idx] of [
    ['ownerA', 0],
    ['ownerA2', 1],
  ] as const) {
    const id = await withTenant(orgA.id, async (tx) => {
      const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
        name: `B.S5 ${tag}`,
        nationalId: `30000000${idx}`,
        phone: `050100000${idx}`,
      });
      const [row] = await tx
        .insert(owners)
        .values({
          orgId: orgA.id,
          nameEncrypted: enc.nameEncrypted,
          nameHash: enc.nameHash,
          nationalIdEncrypted: enc.nationalIdEncrypted,
          nationalIdHash: enc.nationalIdHash,
          phoneEncrypted: enc.phoneEncrypted,
          phoneHash: enc.phoneHash,
        })
        .returning({ id: owners.id });
      return row!.id;
    });
    if (tag === 'ownerA') ownerAId = id;
    else ownerA2Id = id;
  }
}, 60_000);

afterAll(async () => {
  /* pool teardown handled globally */
  void pool;
});

async function expectPgError(
  promise: Promise<unknown>,
  expected: { code?: string; messageMatches?: RegExp },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected promise to reject').toBeDefined();
  let cur: unknown = caught;
  let depth = 0;
  while (cur && depth < 8) {
    const pg = cur as { code?: string; message?: string };
    if (expected.code && pg.code === expected.code) return;
    if (expected.messageMatches && pg.message && expected.messageMatches.test(pg.message)) return;
    cur = (cur as { cause?: unknown })?.cause;
    depth += 1;
  }
  throw new Error(
    `pg error did not match. Looked for ${JSON.stringify(expected)}. ` +
      `Got: ${caught instanceof Error ? caught.message : String(caught)}`,
  );
}

describe('V11 B.S5 · tasks-extended + task_external_attendees — D.38 / D.41 schema', () => {
  it('1) tasks — scheduled_at + location are additive (back-compat: insert without them still works)', async () => {
    // Two inserts: one omitting both, one setting both.
    await withTenant(orgA.id, async (tx) => {
      await tx.insert(tasks).values({
        orgId: orgA.id,
        title: 'plain task',
        createdBy: orgA.users[0]!.id,
      });
      await tx.insert(tasks).values({
        orgId: orgA.id,
        title: 'scheduled task',
        createdBy: orgA.users[0]!.id,
        scheduledAt: new Date('2026-06-01T10:00:00Z'),
        location: 'תל אביב, רחוב הירקון 12',
      });
    });

    const rows = await withTenant(orgA.id, async (tx) =>
      tx
        .select({
          title: tasks.title,
          scheduledAt: tasks.scheduledAt,
          location: tasks.location,
        })
        .from(tasks)
        .where(and(eq(tasks.orgId, orgA.id), eq(tasks.title, 'scheduled task'))),
    );
    expect(rows[0]?.scheduledAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z');
    expect(rows[0]?.location).toBe('תל אביב, רחוב הירקון 12');

    const plain = await withTenant(orgA.id, async (tx) =>
      tx
        .select({
          scheduledAt: tasks.scheduledAt,
          location: tasks.location,
        })
        .from(tasks)
        .where(and(eq(tasks.orgId, orgA.id), eq(tasks.title, 'plain task'))),
    );
    expect(plain[0]?.scheduledAt).toBeNull();
    expect(plain[0]?.location).toBeNull();
  });

  it('2) task_external_attendees — RLS USING: attendee in Org A invisible to Org B', async () => {
    const [att] = await withTenant(orgA.id, async (tx) =>
      tx
        .insert(taskExternalAttendees)
        .values({ taskId: taskAId, ownerId: ownerAId })
        .returning({ id: taskExternalAttendees.id }),
    );
    expect(att?.id).toBeDefined();

    const visibleToB = await withTenant(orgB.id, async (tx) =>
      tx
        .select({ id: taskExternalAttendees.id })
        .from(taskExternalAttendees)
        .where(eq(taskExternalAttendees.id, att!.id)),
    );
    expect(visibleToB).toHaveLength(0);

    const visibleToA = await withTenant(orgA.id, async (tx) =>
      tx
        .select({ id: taskExternalAttendees.id })
        .from(taskExternalAttendees)
        .where(eq(taskExternalAttendees.id, att!.id)),
    );
    expect(visibleToA).toHaveLength(1);
  });

  it('3) RLS WITH CHECK — Org B cannot insert an attendee for Org A’s task', async () => {
    await expectPgError(
      withTenant(orgB.id, async (tx) =>
        tx.insert(taskExternalAttendees).values({
          taskId: taskAId,
          ownerId: ownerAId,
        }),
      ),
      { code: '42501', messageMatches: /row-level security|policy/i },
    );
  });

  it('4) GRANT — app_user has no DELETE on task_external_attendees', async () => {
    await expectPgError(
      withTenant(orgA.id, async (tx) => {
        await tx.execute(sql`DELETE FROM task_external_attendees WHERE id = gen_random_uuid()`);
      }),
      { code: '42501', messageMatches: /permission denied/i },
    );
  });

  it('5) UNIQUE (task_id, owner_id) — same owner cannot be invited twice to same task', async () => {
    // ownerAId already inserted as an attendee in test 2. Re-inserting
    // for the same task must violate the unique index.
    await expectPgError(
      withTenant(orgA.id, async (tx) =>
        tx.insert(taskExternalAttendees).values({ taskId: taskAId, ownerId: ownerAId }),
      ),
      { code: '23505', messageMatches: /task_external_attendees_task_owner_unique/i },
    );

    // ownerA2 (different owner) on same task is allowed.
    await withTenant(orgA.id, async (tx) =>
      tx.insert(taskExternalAttendees).values({
        taskId: taskAId,
        ownerId: ownerA2Id,
      }),
    );
  });

  it('6) idempotency columns — ics_sent_at + ics_cancelled_at update round-trip', async () => {
    // ownerA2 was just added (test 5). Simulate the B.S7 send path:
    // UPDATE ics_sent_at after a successful Resend send.
    const sentTs = new Date('2026-06-01T09:30:00Z');
    await withTenant(orgA.id, async (tx) => {
      await tx
        .update(taskExternalAttendees)
        .set({ icsSentAt: sentTs })
        .where(
          and(
            eq(taskExternalAttendees.taskId, taskAId),
            eq(taskExternalAttendees.ownerId, ownerA2Id),
          ),
        );
    });

    const cancelledTs = new Date('2026-06-01T09:45:00Z');
    await withTenant(orgA.id, async (tx) => {
      await tx
        .update(taskExternalAttendees)
        .set({ icsCancelledAt: cancelledTs })
        .where(
          and(
            eq(taskExternalAttendees.taskId, taskAId),
            eq(taskExternalAttendees.ownerId, ownerA2Id),
          ),
        );
    });

    const [row] = await withTenant(orgA.id, async (tx) =>
      tx
        .select({
          icsSentAt: taskExternalAttendees.icsSentAt,
          icsCancelledAt: taskExternalAttendees.icsCancelledAt,
        })
        .from(taskExternalAttendees)
        .where(
          and(
            eq(taskExternalAttendees.taskId, taskAId),
            eq(taskExternalAttendees.ownerId, ownerA2Id),
          ),
        ),
    );
    expect(row?.icsSentAt?.toISOString()).toBe('2026-06-01T09:30:00.000Z');
    expect(row?.icsCancelledAt?.toISOString()).toBe('2026-06-01T09:45:00.000Z');
  });
});
