/**
 * V11 Track B.S7 — Calendar email dispatcher integration spec (D.38).
 *
 * What this pins
 * ──────────────
 *   1) sendInviteForTask('create') — per-attendee email + per-row
 *      `ics_sent_at` UPDATE; attachment is the B.S6 ICS string with
 *      `text/calendar; method=REQUEST` Content-Type.
 *   2) sendInviteForTask('cancel') — `ics_cancelled_at` UPDATE per row;
 *      Content-Type METHOD=CANCEL.
 *   3) Skip-if-no-op: task with no scheduled_at → sent=0, skipped=1.
 *   4) Skip-if-no-attendees: scheduled task with zero attendee rows →
 *      sent=0, skipped=0.
 *   5) Skip-if-no-email: attendee owner without an email — no email
 *      send, no `ics_sent_at` write (column stays null so the future
 *      "did we email this owner?" report shows the gap).
 *   6) Best-effort posture — provider rejecting one attendee does NOT
 *      block the other; `ics_sent_at` is set ONLY for the success row.
 *   7) Provider throw is logged but never re-thrown out of the
 *      dispatcher (returns { failed: N } instead).
 *
 * Pattern follows portal.s4.spec.ts: service constructed directly, real
 * Neon for RLS + decryption invariants, fake IEmailProvider for the
 * send-channel capture.
 */
import {
  encryptOwnerPii,
  FakeEmailProvider,
  owners,
  taskExternalAttendees,
  tasks,
  withTenant,
  type EmailDeliveryResult,
  type EmailMessage,
  type IEmailProvider,
} from '@emapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { CalendarService } from '../calendar/calendar.service';

import { CalendarEmailService } from './calendar-email.service';

const calendar = new CalendarService();

let orgA: TestOrg;

// Fixture ids
const fx = {
  scheduledTaskId: '',
  unscheduledTaskId: '',
  ownerWithEmailId: '',
  ownerWithEmail2Id: '',
  ownerNoEmailId: '',
};

async function makeOwner(
  o: TestOrg,
  args: { name: string; nationalId: string; phone: string; email: string | null },
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
      name: args.name,
      nationalId: args.nationalId,
      phone: args.phone,
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: o.id,
        nameEncrypted: enc.nameEncrypted,
        nameHash: enc.nameHash,
        nationalIdEncrypted: enc.nationalIdEncrypted,
        nationalIdHash: enc.nationalIdHash,
        phoneEncrypted: enc.phoneEncrypted,
        phoneHash: enc.phoneHash,
        email: args.email,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function makeTask(
  o: TestOrg,
  args: { title: string; scheduledAt: Date | null; location?: string | null },
): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({
        orgId: o.id,
        title: args.title,
        createdBy: o.users[0]!.id,
        scheduledAt: args.scheduledAt,
        location: args.location ?? null,
        durationMinutes: 60,
      })
      .returning({ id: tasks.id });
    return row!.id;
  });
}

async function attachAttendee(o: TestOrg, taskId: string, ownerId: string): Promise<string> {
  return withTenant(o.id, async (tx) => {
    const [row] = await tx
      .insert(taskExternalAttendees)
      .values({ taskId, ownerId })
      .returning({ id: taskExternalAttendees.id });
    return row!.id;
  });
}

async function readAttendee(
  o: TestOrg,
  attendeeId: string,
): Promise<{ icsSentAt: Date | null; icsCancelledAt: Date | null }> {
  return withTenant(o.id, async (tx) => {
    const [r] = await tx
      .select({
        icsSentAt: taskExternalAttendees.icsSentAt,
        icsCancelledAt: taskExternalAttendees.icsCancelledAt,
      })
      .from(taskExternalAttendees)
      .where(eq(taskExternalAttendees.id, attendeeId))
      .limit(1);
    return r!;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  const ts = Date.now();
  orgA = await createTestOrg(`B7-${ts}`, `b7-${ts}`);

  // One scheduled task (the happy-path subject) + one non-calendar to-do.
  fx.scheduledTaskId = await makeTask(orgA, {
    title: 'פגישה עם בעלי דירות',
    scheduledAt: new Date('2026-06-15T09:00:00Z'),
    location: 'משרד היזם, רח׳ דיזנגוף 100',
  });
  fx.unscheduledTaskId = await makeTask(orgA, {
    title: 'משימה ללא תזמון',
    scheduledAt: null,
  });

  // Owners: two with email (parallel-send happy path), one without
  // (no-email skip path).
  fx.ownerWithEmailId = await makeOwner(orgA, {
    name: 'דוד כהן',
    nationalId: '300000010',
    phone: '0501000010',
    email: 'david@example.com',
  });
  fx.ownerWithEmail2Id = await makeOwner(orgA, {
    name: 'שרה לוי',
    nationalId: '300000011',
    phone: '0501000011',
    email: 'sara@example.com',
  });
  fx.ownerNoEmailId = await makeOwner(orgA, {
    name: 'משה דוד',
    nationalId: '300000012',
    phone: '0501000012',
    email: null,
  });
}, 60_000);

afterAll(async () => {
  void pool;
});

describe('V11 B.S7 · CalendarEmailService — D.38 send + idempotency', () => {
  let fakeEmail: FakeEmailProvider;
  let svc: CalendarEmailService;

  beforeEach(() => {
    fakeEmail = new FakeEmailProvider();
    svc = new CalendarEmailService(fakeEmail, calendar);
  });

  it('1) create — emails every attendee with-email + sets ics_sent_at per row + ICS attachment uses METHOD=REQUEST', async () => {
    const attendeeId = await attachAttendee(orgA, fx.scheduledTaskId, fx.ownerWithEmailId);
    const attendee2Id = await attachAttendee(orgA, fx.scheduledTaskId, fx.ownerWithEmail2Id);

    const result = await svc.sendInviteForTask(orgA.id, fx.scheduledTaskId, 'create');

    expect(result).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(fakeEmail.sent).toHaveLength(2);
    const recipients = fakeEmail.sent.map((m) => m.to).sort();
    expect(recipients).toEqual(['david@example.com', 'sara@example.com']);
    for (const msg of fakeEmail.sent) {
      expect(msg.subject).toMatch(/^\[הזמנה\] /);
      expect(msg.attachments).toHaveLength(1);
      const att = msg.attachments![0]!;
      expect(att.filename).toBe('event.ics');
      expect(att.contentType).toBe('text/calendar; method=REQUEST');
      // RFC 5545 brackets + REQUEST method line present in the payload.
      expect(att.content).toContain('BEGIN:VCALENDAR');
      expect(att.content).toContain('METHOD:REQUEST');
      expect(att.content).toContain('END:VCALENDAR');
      expect(msg.tags?.['source']).toBe('calendar');
      expect(msg.tags?.['action']).toBe('create');
    }
    const a1 = await readAttendee(orgA, attendeeId);
    const a2 = await readAttendee(orgA, attendee2Id);
    expect(a1.icsSentAt).toBeInstanceOf(Date);
    expect(a2.icsSentAt).toBeInstanceOf(Date);
    expect(a1.icsCancelledAt).toBeNull();
    expect(a2.icsCancelledAt).toBeNull();
  });

  it('2) cancel — writes ics_cancelled_at + METHOD=CANCEL attachment', async () => {
    // Fresh task so attendees start clean.
    const taskId = await makeTask(orgA, {
      title: 'פגישה לבטל',
      scheduledAt: new Date('2026-06-20T10:00:00Z'),
    });
    const attendeeId = await attachAttendee(orgA, taskId, fx.ownerWithEmailId);

    const result = await svc.sendInviteForTask(orgA.id, taskId, 'cancel');

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(fakeEmail.sent).toHaveLength(1);
    const msg = fakeEmail.sent[0]!;
    expect(msg.subject).toMatch(/^\[בוטל\] /);
    expect(msg.attachments![0]!.contentType).toBe('text/calendar; method=CANCEL');
    expect(msg.attachments![0]!.content).toContain('METHOD:CANCEL');
    expect(msg.tags?.['action']).toBe('cancel');
    const a = await readAttendee(orgA, attendeeId);
    expect(a.icsCancelledAt).toBeInstanceOf(Date);
  });

  it('3) skip — task with no scheduled_at returns { skipped: 1 } and sends nothing', async () => {
    await attachAttendee(orgA, fx.unscheduledTaskId, fx.ownerWithEmailId);
    const result = await svc.sendInviteForTask(orgA.id, fx.unscheduledTaskId, 'create');
    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(fakeEmail.sent).toHaveLength(0);
  });

  it('4) skip — scheduled task with zero attendees is a no-op', async () => {
    const taskId = await makeTask(orgA, {
      title: 'פגישה ללא משתתפים',
      scheduledAt: new Date('2026-06-21T11:00:00Z'),
    });
    const result = await svc.sendInviteForTask(orgA.id, taskId, 'create');
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(fakeEmail.sent).toHaveLength(0);
  });

  it('5) skip — attendee owner with no email: no send, ics_sent_at stays null', async () => {
    const taskId = await makeTask(orgA, {
      title: 'פגישה — בעל אחד ללא אימייל',
      scheduledAt: new Date('2026-06-22T12:00:00Z'),
    });
    const noEmailAttId = await attachAttendee(orgA, taskId, fx.ownerNoEmailId);
    const withEmailAttId = await attachAttendee(orgA, taskId, fx.ownerWithEmailId);

    const result = await svc.sendInviteForTask(orgA.id, taskId, 'create');

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(fakeEmail.sent).toHaveLength(1);
    expect(fakeEmail.sent[0]!.to).toBe('david@example.com');

    const noEmailAtt = await readAttendee(orgA, noEmailAttId);
    const withEmailAtt = await readAttendee(orgA, withEmailAttId);
    expect(noEmailAtt.icsSentAt).toBeNull(); // gap preserved for the audit
    expect(withEmailAtt.icsSentAt).toBeInstanceOf(Date);
  });

  it('6) failure tolerance — provider rejects one attendee; the other still ships', async () => {
    const taskId = await makeTask(orgA, {
      title: 'פגישה עם דחייה חלקית',
      scheduledAt: new Date('2026-06-23T13:00:00Z'),
    });
    const okAttId = await attachAttendee(orgA, taskId, fx.ownerWithEmailId);
    const failAttId = await attachAttendee(orgA, taskId, fx.ownerWithEmail2Id);

    const flaky: IEmailProvider = {
      async send(m: EmailMessage): Promise<EmailDeliveryResult> {
        if (m.to === 'sara@example.com') {
          return { id: 'rej', status: 'rejected', error: 'simulated bounce' };
        }
        return { id: 'ok', status: 'sent' };
      },
      async healthCheck(): Promise<void> {},
    };
    const flakeSvc = new CalendarEmailService(flaky, calendar);

    const result = await flakeSvc.sendInviteForTask(orgA.id, taskId, 'create');

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const ok = await readAttendee(orgA, okAttId);
    const failed = await readAttendee(orgA, failAttId);
    expect(ok.icsSentAt).toBeInstanceOf(Date); // partial-success audit row
    expect(failed.icsSentAt).toBeNull(); // failure leaves the column null
  });

  it('7) provider throws — caught, counted as failed, never re-thrown', async () => {
    const taskId = await makeTask(orgA, {
      title: 'פגישה — provider שנופל',
      scheduledAt: new Date('2026-06-24T14:00:00Z'),
    });
    const attId = await attachAttendee(orgA, taskId, fx.ownerWithEmailId);

    const thrower: IEmailProvider = {
      async send(): Promise<EmailDeliveryResult> {
        throw new Error('network down');
      },
      async healthCheck(): Promise<void> {},
    };
    const throwSvc = new CalendarEmailService(thrower, calendar);

    // Should resolve (NOT throw) and report failed=1.
    const result = await throwSvc.sendInviteForTask(orgA.id, taskId, 'create');
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    const att = await readAttendee(orgA, attId);
    expect(att.icsSentAt).toBeNull();
  });
});
