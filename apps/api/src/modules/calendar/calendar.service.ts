import { Injectable } from '@nestjs/common';
import ical, {
  ICalCalendarMethod,
  type ICalCalendarData,
  type ICalEventData,
} from 'ical-generator';

/**
 * Calendar input shape — task + attendees + organizer — passed to the
 * generator as plain data. Decoupled from Drizzle types so this module
 * stays a pure function of its inputs and B.S7 (Resend integration)
 * can build the input from any source (DB read, test fixture, etc.).
 */
export interface IcsTaskInput {
  /** Stable across re-sends. Used as the iCal UID — recipients' clients
   *  match it to update/cancel an existing event in place. */
  taskId: string;
  /** ICS SUMMARY. Required (RFC 5545 §3.8.1.12). */
  title: string;
  /** Optional ICS DESCRIPTION. */
  description?: string | null;
  /** ICS LOCATION (free text). Optional. */
  location?: string | null;
  /** ICS DTSTART — task.scheduled_at (B.S5 migration 0036). Required
   *  for a calendar event; B.S7 should skip ICS generation for tasks
   *  without a scheduled time. */
  scheduledAt: Date;
  /** Computed end time = scheduledAt + durationMinutes. If duration is
   *  null, defaults to 60 minutes (RFC 5545 has no "open-ended" event;
   *  every VEVENT needs a DTEND or DURATION). */
  durationMinutes?: number | null;
  /** ICS SEQUENCE — increments on every send. Used by RFC 5545 clients
   *  to know "this version supersedes the previous one". Source:
   *  `tasks.updated_at` epoch ms divided by 1000 (any monotonic value
   *  works; epoch s is human-readable and naturally monotonic). */
  sequence: number;
}

/** ORGANIZER — the Manager/Agent who created the task. */
export interface IcsOrganizerInput {
  name: string;
  email: string;
}

/** ATTENDEE — Tier-2 owner invited via task_external_attendees. Email
 *  is optional because owners often have no email in dev/production
 *  (SMS-only contact); when missing, we synthesise a `mailto:NONE` URI
 *  rather than drop the row, so the client sees the invite even if
 *  no reply path exists. B.S7 will decide whether to actually email
 *  them based on a separate email-presence check. */
export interface IcsAttendeeInput {
  ownerId: string;
  name: string;
  email?: string | null;
}

/**
 * Calendar service — pure-function RFC 5545 ICS generator (D.38, V11 B.S6).
 *
 * This module has NO controller, NO DB access, NO DI dependencies. It's
 * a thin wrapper around `ical-generator` that fixes our conventions
 * (UID = taskId, METHOD = REQUEST/CANCEL, SEQUENCE = epoch sec of
 * updated_at, PRODID = EMAPP) so every send is consistent.
 *
 * Usage (from B.S7 Resend integration — not yet wired):
 *   const ics = calendar.generateRequest({ task, organizer, attendees });
 *   await email.send({ to, subject, html, attachments: [{
 *     filename: 'event.ics',
 *     content: ics,
 *     contentType: 'text/calendar; method=REQUEST',
 *   }]});
 *
 * Why pure-function:
 *   - Easy to unit-test (no DB, no network, no DI).
 *   - B.S7 can choose its own data source (a single task event vs a
 *     batch of "tasks scheduled this week" digest).
 *   - The future export endpoint (B.S10) can re-use the same function
 *     to produce calendar attachments for the Excel/PDF download.
 *
 * RFC 5545 conformance pinned by tests (calendar.service.spec.ts):
 *   - BEGIN:VCALENDAR + END:VCALENDAR brackets, VERSION 2.0, PRODID
 *   - METHOD line matches REQUEST or CANCEL
 *   - Exactly one VEVENT per call (we do per-task events; aggregate
 *     calendars are a future enhancement)
 *   - UID stable across resends (= taskId — clients dedupe in-place)
 *   - SEQUENCE monotonic (any client expecting strict monotonicity
 *     will be happy with our epoch-second approach)
 *   - DTSTART + DTEND set; LOCATION + DESCRIPTION present iff input
 *     supplied them
 *   - One ATTENDEE line per attendee; mailto: URI even when email is
 *     null (RFC 5545 §3.3.3 — the URI is required by syntax)
 */
@Injectable()
export class CalendarService {
  /** RFC 5545 PRODID — identifies the producer of the calendar.
   *  Object form so ical-generator builds the canonical
   *  `-//EMAPP//Urban Renewal Calendar//HE` shape without the
   *  double-dash artifact you get when you pass the assembled string
   *  yourself (the lib prepends `-//` either way; providing it as a
   *  string results in `--//EMAPP//…`). */
  private static readonly PRODID = {
    company: 'EMAPP',
    product: 'Urban Renewal Calendar',
    language: 'HE',
  } as const;
  /** Default event duration when `durationMinutes` is null — 60 min is
   *  a sensible meeting default and avoids RFC 5545's "must have DTEND
   *  or DURATION" requirement. */
  private static readonly DEFAULT_DURATION_MIN = 60;

  /**
   * METHOD:REQUEST — task create or update. Recipients' calendar
   *  clients add (or update in place via UID match) the event.
   */
  generateRequest(input: {
    task: IcsTaskInput;
    organizer: IcsOrganizerInput;
    attendees: readonly IcsAttendeeInput[];
  }): string {
    return this.buildIcs(input, ICalCalendarMethod.REQUEST);
  }

  /**
   * METHOD:CANCEL — task cancelled (archived) or scheduled_at cleared.
   *  Recipients' clients remove the event (matched by UID).
   *  The cancel ICS still needs to mention the original DTSTART and
   *  attendees so clients can identify the right event to remove —
   *  the input shape is identical to generateRequest.
   */
  generateCancel(input: {
    task: IcsTaskInput;
    organizer: IcsOrganizerInput;
    attendees: readonly IcsAttendeeInput[];
  }): string {
    return this.buildIcs(input, ICalCalendarMethod.CANCEL);
  }

  // ── private ──────────────────────────────────────────────────────────

  private buildIcs(
    input: {
      task: IcsTaskInput;
      organizer: IcsOrganizerInput;
      attendees: readonly IcsAttendeeInput[];
    },
    method: ICalCalendarMethod,
  ): string {
    const { task, organizer, attendees } = input;

    const calendarData: ICalCalendarData = {
      prodId: CalendarService.PRODID,
      method,
    };
    const cal = ical(calendarData);

    const durationMs = (task.durationMinutes ?? CalendarService.DEFAULT_DURATION_MIN) * 60 * 1000;
    const end = new Date(task.scheduledAt.getTime() + durationMs);

    const eventData: ICalEventData = {
      // Stable UID so resends (UPDATE/CANCEL) match the same event in
      // recipients' calendars instead of creating duplicates. Suffix
      // `@emapp` per RFC 5545 §3.8.4.7 best-practice (looks like an
      // email address even though it isn't one).
      id: `${task.taskId}@emapp`,
      start: task.scheduledAt,
      end,
      summary: task.title,
      description: task.description ?? undefined,
      location: task.location ?? undefined,
      sequence: task.sequence,
      organizer: { name: organizer.name, email: organizer.email },
    };

    const event = cal.createEvent(eventData);

    for (const a of attendees) {
      // RFC 5545 §3.3.3 — ATTENDEE value is always a CAL-ADDRESS URI
      // (mailto: in practice). For owners without an email on file,
      // we emit `mailto:NONE` so the line is syntactically valid; B.S7
      // separately decides whether to actually SEND to such an attendee.
      const email = a.email && a.email.length > 0 ? a.email : 'NONE';
      event.createAttendee({
        name: a.name,
        email,
        rsvp: true,
      });
    }

    return cal.toString();
  }
}
