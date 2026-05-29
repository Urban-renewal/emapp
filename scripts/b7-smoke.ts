/**
 * V11 B.S7 smoke runner — D.38 calendar email dispatch.
 *
 * Uses the sanctioned `withTenant` wrapper to:
 *   1) Attach 2 external attendees to a pre-created task (no CRUD
 *      endpoint exists yet; that's B.S8/B.S9 — this script keeps
 *      the RLS boundary by going through withTenant).
 *   2) Read back `ics_sent_at` for both attendee rows after an HTTP
 *      PATCH triggers the post-write hook.
 *
 * Run AFTER the curl smoke has created the task; pass the IDs via
 * env vars TASK_ID, ORG_ID, OWNER_A, OWNER_B.
 */
/* eslint-disable no-console */
import { eq, and } from 'drizzle-orm';

import { taskExternalAttendees } from '../packages/db/src/schema/collaboration';
import { withTenant } from '../packages/db/src/wrappers/with-tenant';

const TASK = process.env['TASK_ID']!;
const ORG = process.env['ORG_ID']!;
const A = process.env['OWNER_A']!;
const B = process.env['OWNER_B']!;
const MODE = process.env['MODE'] ?? 'attach'; // 'attach' | 'read'

async function attach(): Promise<void> {
  const ids = await withTenant(ORG, async (tx) => {
    const r1 = await tx
      .insert(taskExternalAttendees)
      .values({ taskId: TASK, ownerId: A })
      .returning({ id: taskExternalAttendees.id });
    const r2 = await tx
      .insert(taskExternalAttendees)
      .values({ taskId: TASK, ownerId: B })
      .returning({ id: taskExternalAttendees.id });
    return [r1[0]!.id, r2[0]!.id];
  });
  console.log(JSON.stringify({ attendeeIds: ids }));
}

async function read(): Promise<void> {
  const rows = await withTenant(ORG, async (tx) => {
    return tx
      .select({
        id: taskExternalAttendees.id,
        ownerId: taskExternalAttendees.ownerId,
        icsSentAt: taskExternalAttendees.icsSentAt,
        icsCancelledAt: taskExternalAttendees.icsCancelledAt,
      })
      .from(taskExternalAttendees)
      .where(eq(taskExternalAttendees.taskId, TASK));
  });
  console.log(JSON.stringify(rows, null, 2));
}

async function main(): Promise<void> {
  if (MODE === 'attach') await attach();
  else if (MODE === 'read') await read();
  else throw new Error(`unknown MODE=${MODE}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// silence unused lint
void and;
