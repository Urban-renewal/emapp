import {
  decryptOwnerNamesBatch,
  owners,
  taskExternalAttendees,
  tasks,
  users,
  withTenant,
  type IEmailProvider,
} from '@emapp/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  CalendarService,
  type IcsAttendeeInput,
  type IcsOrganizerInput,
  type IcsTaskInput,
} from '../calendar/calendar.service';
import { EMAIL_PROVIDER } from '../members/invite-email';

/** What kind of email this is — drives ICS METHOD + subject prefix. */
export type CalendarEmailAction = 'create' | 'update' | 'cancel';

type CalendarSendCounts = { sent: number; skipped: number; failed: number };

/**
 * Phase-1 result of `sendInviteForTask`: either an early-exit outcome (`skip`)
 * or the prepared payload (`send`) to dispatch OUTSIDE the read tx. Explicit
 * discriminated union (the `?: never` arms) so `'skip' in prepared` narrows
 * cleanly instead of widening `.skip` to `… | undefined`.
 */
type PreparedCalendar =
  | { kind: 'skip'; counts: CalendarSendCounts }
  | {
      kind: 'send';
      attendees: Array<IcsAttendeeInput & { _attendeeId: string }>;
      icsInput: { task: IcsTaskInput; organizer: IcsOrganizerInput; attendees: IcsAttendeeInput[] };
    };

/**
 * Calendar email service — V11 B.S7 (D.38).
 *
 * Wires CalendarService (B.S6, pure-function ICS generator) to
 * IEmailProvider (D.27 pattern, FakeEmailProvider in dev /
 * ResendEmailProvider in prod once Lidor provisions the credential
 * in Infisical). One public method:
 *
 *   sendInviteForTask(taskId, action) → loads task + organizer +
 *     external attendees inside withTenant, generates ICS, sends one
 *     email per attendee (parallel), updates `task_external_attendees`
 *     `ics_sent_at` / `ics_cancelled_at` per row to record delivery
 *     for the B.S5 idempotency columns.
 *
 * Posture:
 *   - Inline (NOT a pg-boss job). Matches D.27 member-invite email —
 *     fire-and-forget at the call site. Latency is ~500ms × attendees;
 *     acceptable for a Manager workflow. If/when 50+ attendees per
 *     task become common, promote to a job.
 *   - Best-effort. A failed send does NOT throw out of the caller's
 *     stack (TasksService.create won't fail because email broke).
 *     Failures are logged with the attendee id + error; the absence
 *     of `ics_sent_at` is the audit trail.
 *   - Skip-if-no-op:
 *       * task.scheduled_at is null → no calendar event to send
 *       * task has no external_attendees → nothing to send to
 *       * task.archived_at present and action != 'cancel' → no-op
 *         (handled by caller; service treats input at face value)
 *   - Same withTenant tx as the post-write UPDATE; both pass through
 *     RLS the same way. Each per-attendee UPDATE is its own statement
 *     (not bulk) so a partial failure marks only the rows that
 *     actually sent.
 *
 * NOT in scope here:
 *   - SMS fallback for owners with no email (Phase 2; out of D.38).
 *   - HTML body template (currently text-only with the ICS as the
 *     only payload — calendar clients show "Add to calendar"
 *     automatically; richer body lands when copy + a designer
 *     template arrive).
 *   - Throttling (Resend has its own; FakeEmailProvider is instant).
 */
@Injectable()
export class CalendarEmailService {
  private readonly logger = new Logger(CalendarEmailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
    private readonly calendar: CalendarService,
  ) {}

  /**
   * Send the calendar ICS for a task to all its external attendees.
   * Returns the per-attendee outcome — caller (typically TasksService
   * via the post-write hook) can log/audit but doesn't need to act on
   * failures (best-effort posture).
   */
  async sendInviteForTask(
    orgId: string,
    taskId: string,
    action: CalendarEmailAction,
  ): Promise<{ sent: number; skipped: number; failed: number }> {
    // Phase 1 — READ everything inside a short tenant tx and return either an
    // early-exit outcome (`skip`) or the prepared payload (`send`). NOTHING
    // external runs here, so the pooled connection is released as soon as the
    // reads finish (H2: the Resend calls used to run INSIDE this tx, holding a
    // DB connection across N external round-trips).
    const prepared = await withTenant(orgId, async (tx): Promise<PreparedCalendar> => {
      // 1. Load task — must exist + (for non-cancel) have scheduled_at.
      const [task] = await tx
        .select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          location: tasks.location,
          scheduledAt: tasks.scheduledAt,
          durationMinutes: tasks.durationMinutes,
          updatedAt: tasks.updatedAt,
          createdBy: tasks.createdBy,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);

      if (!task) {
        this.logger.warn(`task ${taskId} not found in org ${orgId}; skip ICS send`);
        return { kind: 'skip', counts: { sent: 0, skipped: 1, failed: 0 } };
      }
      if (!task.scheduledAt) {
        // No-op for tasks without a calendar time. (Common case: a
        // Manager creates a non-calendar to-do that uses the same
        // `tasks` table but doesn't go on the WeekCalendar.)
        return { kind: 'skip', counts: { sent: 0, skipped: 1, failed: 0 } };
      }

      // 2. Load organizer (the user who created the task) — name + email.
      const [organizer] = await tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, task.createdBy))
        .limit(1);
      if (!organizer) {
        // Shouldn't happen — createdBy is FK NOT NULL — but guard
        // against the row being archived/removed via provider tier.
        this.logger.warn(`organizer ${task.createdBy} not found; skip ICS send`);
        return { kind: 'skip', counts: { sent: 0, skipped: 1, failed: 0 } };
      }

      // 3. Load external attendees + their (decrypted) name + email.
      //    LEFT JOIN owners to get the contact info. RLS already
      //    scoped both tables to this org via the GUC.
      const attendeeRows = await tx
        .select({
          attendeeId: taskExternalAttendees.id,
          ownerId: taskExternalAttendees.ownerId,
          nameEncrypted: owners.nameEncrypted,
          email: owners.email,
        })
        .from(taskExternalAttendees)
        .innerJoin(owners, eq(owners.id, taskExternalAttendees.ownerId))
        .where(and(eq(taskExternalAttendees.taskId, taskId), isNull(owners.archivedAt)));

      if (attendeeRows.length === 0) {
        return { kind: 'skip', counts: { sent: 0, skipped: 0, failed: 0 } };
      }

      // 4. Decrypt names in ONE pgcrypto round-trip via the batched
      //    helper (was N round-trips serialised on the single tx
      //    connection — Promise.all does NOT parallelise drizzle calls
      //    on a single tx). Audit H1-perf fix: a 20-attendee task
      //    dropped from ~1 s to ~50 ms on Neon. Promise.all inside the
      //    tx had been blocking the row lock until ICS dispatch.
      const decrypted = await decryptOwnerNamesBatch(
        tx as unknown as Parameters<typeof decryptOwnerNamesBatch>[0],
        attendeeRows.map((r) => ({ key: r.attendeeId, nameEncrypted: r.nameEncrypted })),
      );
      const nameByAttendeeId = new Map(decrypted.map((d) => [d.key, d.name]));
      const attendees: Array<IcsAttendeeInput & { _attendeeId: string }> = attendeeRows.map(
        (r) => ({
          _attendeeId: r.attendeeId,
          ownerId: r.ownerId,
          name: nameByAttendeeId.get(r.attendeeId) ?? '',
          email: r.email,
        }),
      );

      // 5. Generate ICS once (same payload for all attendees).
      const icsInput: {
        task: IcsTaskInput;
        organizer: IcsOrganizerInput;
        attendees: IcsAttendeeInput[];
      } = {
        task: {
          taskId: task.id,
          title: task.title,
          description: task.description,
          location: task.location,
          scheduledAt: task.scheduledAt,
          durationMinutes: task.durationMinutes,
          // SEQUENCE = updated_at epoch-seconds — naturally monotonic.
          sequence: Math.floor(task.updatedAt.getTime() / 1000),
        },
        organizer: { name: organizer.name, email: organizer.email },
        attendees: attendees.map((a) => ({
          ownerId: a.ownerId,
          name: a.name,
          email: a.email,
        })),
      };
      return { kind: 'send', attendees, icsInput };
    });

    if (prepared.kind === 'skip') return prepared.counts;
    const { attendees, icsInput } = prepared;

    // Phase 2 — generate the ICS (pure) and send per-attendee OUTSIDE any tx.
    // Run in parallel; each attendee is independent and one failure doesn't
    // gate the rest. Failures are logged, counted, never thrown.
    const ics =
      action === 'cancel'
        ? this.calendar.generateCancel(icsInput)
        : this.calendar.generateRequest(icsInput);
    const icsContentType =
      action === 'cancel' ? 'text/calendar; method=CANCEL' : 'text/calendar; method=REQUEST';

    let sent = 0;
    let failed = 0;
    const deliveredAttendeeIds: string[] = [];
    await Promise.all(
      attendees.map(async (a) => {
        // Skip attendees with no email — the ICS still mentions them (CN line
        // with mailto:NONE), but we can't deliver an invite. No marker is
        // written (the B.S5 ics_sent_at column stays null) so a future "did we
        // email this owner?" report shows they never got it.
        if (!a.email || a.email.length === 0) {
          return;
        }
        try {
          const result = await this.email.send({
            to: a.email,
            subject: this.buildSubject(icsInput.task.title, action),
            text: this.buildPlainBody(icsInput.task.title, action),
            attachments: [{ filename: 'event.ics', content: ics, contentType: icsContentType }],
            tags: { source: 'calendar', taskId: icsInput.task.taskId, action },
          });
          if (result.status === 'rejected') {
            this.logger.warn(
              `email rejected for attendee ${a._attendeeId}: ${result.error ?? 'unknown'}`,
            );
            failed += 1;
            return;
          }
          deliveredAttendeeIds.push(a._attendeeId);
          sent += 1;
        } catch (err) {
          this.logger.error(
            `email send threw for attendee ${a._attendeeId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          failed += 1;
        }
      }),
    );

    // Phase 3 — record delivery markers in a SECOND short tx: ONE batched
    // UPDATE over only the successfully-delivered attendees. This preserves the
    // per-row B.S5 audit semantics (a rejected / no-email / threw row keeps a
    // null marker). The single timestamp is correct — the column is a
    // "did we send" marker, not a re-send guard.
    if (deliveredAttendeeIds.length > 0) {
      await withTenant(orgId, async (tx) => {
        await tx
          .update(taskExternalAttendees)
          .set(action === 'cancel' ? { icsCancelledAt: new Date() } : { icsSentAt: new Date() })
          .where(inArray(taskExternalAttendees.id, deliveredAttendeeIds));
      });
    }

    return { sent, skipped: attendees.length - sent - failed, failed };
  }

  private buildSubject(title: string, action: CalendarEmailAction): string {
    // Hebrew subjects per the partner's UX language (Doc 06 §locale).
    // Keep prefix tags short so mail clients don't truncate the title.
    const prefix = action === 'cancel' ? '[בוטל]' : action === 'update' ? '[עודכן]' : '[הזמנה]';
    return `${prefix} ${title}`;
  }

  private buildPlainBody(title: string, action: CalendarEmailAction): string {
    // Minimal plaintext body — the recipient's calendar client uses the
    // .ics attachment for the "Add to calendar" affordance. Richer
    // template lands in a later UX slice.
    if (action === 'cancel') {
      return `הפגישה "${title}" בוטלה. הקליינט שלך אמור להסיר אותה אוטומטית מהיומן.`;
    }
    if (action === 'update') {
      return `הפגישה "${title}" עודכנה. הקליינט שלך אמור לרענן אותה ביומן.`;
    }
    return `הוזמנת לפגישה "${title}". פתח את הקובץ המצורף כדי להוסיף ליומן שלך.`;
  }
}
