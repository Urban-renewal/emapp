/**
 * V11 B.S6 — CalendarService unit spec (D.38).
 *
 * Pure-function tests — no DB, no network, no DI. Validates the RFC
 * 5545 invariants we promise via comments in calendar.service.ts:
 *
 *   1) BEGIN:VCALENDAR / END:VCALENDAR brackets + VERSION 2.0
 *   2) PRODID matches our convention
 *   3) METHOD line — REQUEST for generateRequest, CANCEL for
 *      generateCancel
 *   4) UID = `<taskId>@emapp` (stable across resends)
 *   5) SEQUENCE — emitted, monotonic
 *   6) DTSTART + DTEND set; DTEND = DTSTART + duration; default 60min
 *   7) SUMMARY = title (required)
 *   8) LOCATION + DESCRIPTION present iff input supplied
 *   9) ORGANIZER line with name + email
 *  10) ATTENDEE line per attendee; mailto:NONE when email missing
 *  11) UTF-8 (Hebrew title + location) round-trips cleanly
 */
import { describe, expect, it } from 'vitest';

import { CalendarService } from './calendar.service';

const svc = new CalendarService();

/** RFC 5545 §3.1 line unfolding — any CRLF followed by a single space
 *  is a line continuation. ical-generator wraps lines >75 chars (e.g.,
 *  attendee addresses on long emails); without unfolding, regex
 *  assertions that expect contiguous strings will break. Every ICS
 *  parser does this as the first step. */
function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, '');
}

const BASE_TASK = {
  taskId: '11111111-1111-4111-8111-111111111111',
  title: 'Calendar smoke test',
  scheduledAt: new Date('2026-06-01T10:00:00Z'),
  durationMinutes: 90,
  sequence: 1779048000,
} as const;

const ORG = { name: 'מיכל מנהלת', email: 'manager@alpha.dev' } as const;

const ATTENDEE_A = {
  ownerId: '22222222-2222-4222-8222-222222222222',
  name: 'דוד תנעמי',
  email: 'david@example.com',
} as const;

const ATTENDEE_NO_EMAIL = {
  ownerId: '33333333-3333-4333-8333-333333333333',
  name: 'שרה כהן',
  email: null,
} as const;

describe('CalendarService — RFC 5545 ICS generation (D.38, V11 B.S6)', () => {
  it('1) wraps output in BEGIN:VCALENDAR / END:VCALENDAR + VERSION 2.0', () => {
    const ics = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    expect(ics).toMatch(/^BEGIN:VCALENDAR/m);
    expect(ics).toMatch(/END:VCALENDAR\s*$/);
    expect(ics).toMatch(/^VERSION:2\.0/m);
  });

  it('2) emits PRODID matching the EMAPP convention', () => {
    const ics = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    expect(ics).toMatch(/^PRODID:-\/\/EMAPP\/\/Urban Renewal Calendar\/\/HE/m);
  });

  it('3a) generateRequest emits METHOD:REQUEST', () => {
    const ics = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    expect(ics).toMatch(/^METHOD:REQUEST/m);
    expect(ics).not.toMatch(/^METHOD:CANCEL/m);
  });

  it('3b) generateCancel emits METHOD:CANCEL', () => {
    const ics = svc.generateCancel({ task: BASE_TASK, organizer: ORG, attendees: [] });
    expect(ics).toMatch(/^METHOD:CANCEL/m);
    expect(ics).not.toMatch(/^METHOD:REQUEST/m);
  });

  it('4) UID = `<taskId>@emapp` (stable across resends — clients dedupe in place)', () => {
    const a = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    const b = svc.generateRequest({
      task: { ...BASE_TASK, title: 'Renamed', sequence: BASE_TASK.sequence + 1 },
      organizer: ORG,
      attendees: [],
    });
    // Same UID across calls even when other fields change → clients
    // match and update the existing event.
    const uid = `UID:${BASE_TASK.taskId}@emapp`;
    expect(a).toContain(uid);
    expect(b).toContain(uid);
  });

  it('5) SEQUENCE emitted and equals the input value (B.S7 sets it from updated_at)', () => {
    const ics = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    expect(ics).toMatch(/^SEQUENCE:1779048000/m);
  });

  it('6a) DTSTART + DTEND set; DTEND = DTSTART + durationMinutes', () => {
    const ics = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    // ical-generator formats DTSTART in UTC as YYYYMMDDTHHMMSSZ.
    expect(ics).toMatch(/^DTSTART:20260601T100000Z/m);
    // 10:00 + 90 min = 11:30.
    expect(ics).toMatch(/^DTEND:20260601T113000Z/m);
  });

  it('6b) durationMinutes default = 60 when null', () => {
    const ics = svc.generateRequest({
      task: { ...BASE_TASK, durationMinutes: null },
      organizer: ORG,
      attendees: [],
    });
    expect(ics).toMatch(/^DTSTART:20260601T100000Z/m);
    expect(ics).toMatch(/^DTEND:20260601T110000Z/m);
  });

  it('7) SUMMARY = title (required)', () => {
    const ics = svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] });
    expect(ics).toMatch(/^SUMMARY:Calendar smoke test/m);
  });

  it('8a) LOCATION present when input supplies it', () => {
    const ics = svc.generateRequest({
      task: { ...BASE_TASK, location: 'Tel Aviv, Hayarkon 12' },
      organizer: ORG,
      attendees: [],
    });
    expect(ics).toMatch(/^LOCATION:Tel Aviv\\, Hayarkon 12/m);
  });

  it('8b) LOCATION absent when input has null', () => {
    const ics = svc.generateRequest({
      task: { ...BASE_TASK, location: null },
      organizer: ORG,
      attendees: [],
    });
    expect(ics).not.toMatch(/^LOCATION:/m);
  });

  it('8c) DESCRIPTION present when input supplies it', () => {
    const ics = svc.generateRequest({
      task: { ...BASE_TASK, description: 'Quarterly review' },
      organizer: ORG,
      attendees: [],
    });
    expect(ics).toMatch(/^DESCRIPTION:Quarterly review/m);
  });

  it('9) ORGANIZER line present with CN + MAILTO (ical-generator emits lowercase mailto here, uppercase MAILTO elsewhere)', () => {
    const ics = unfold(svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [] }));
    // unfold() above handles the >75-char line fold. mailto case-
    // insensitive per RFC 5545 §3.3.3 (the URI scheme is canonical
    // lowercase, but ical-generator's output is inconsistent —
    // lowercase on ORGANIZER, uppercase on ATTENDEE; both are valid).
    expect(ics).toMatch(/^ORGANIZER[;:][^]*mailto:manager@alpha\.dev/im);
  });

  it('10a) ATTENDEE line per attendee (with email)', () => {
    const ics = unfold(
      svc.generateRequest({ task: BASE_TASK, organizer: ORG, attendees: [ATTENDEE_A] }),
    );
    expect(ics).toMatch(/^ATTENDEE[;:][^]*mailto:david@example\.com/im);
  });

  it('10b) ATTENDEE MAILTO:NONE when email is null (RFC 5545 §3.3.3 syntax requirement)', () => {
    const ics = unfold(
      svc.generateRequest({
        task: BASE_TASK,
        organizer: ORG,
        attendees: [ATTENDEE_NO_EMAIL],
      }),
    );
    expect(ics).toMatch(/^ATTENDEE[;:][^]*mailto:NONE/im);
  });

  it('10c) one ATTENDEE line per attendee when multiple supplied', () => {
    const ics = svc.generateRequest({
      task: BASE_TASK,
      organizer: ORG,
      attendees: [ATTENDEE_A, ATTENDEE_NO_EMAIL],
    });
    const attendeeLines = ics.split(/\r?\n/).filter((l) => l.startsWith('ATTENDEE'));
    expect(attendeeLines).toHaveLength(2);
  });

  it('11) UTF-8 — Hebrew title + location survive the round-trip', () => {
    const ics = svc.generateRequest({
      task: {
        ...BASE_TASK,
        title: 'פגישה בבניין',
        location: 'תל אביב, רחוב הירקון 12',
      },
      organizer: ORG,
      attendees: [],
    });
    expect(ics).toContain('SUMMARY:פגישה בבניין');
    // Comma escaped per RFC 5545 §3.3.11 text rule (\, → comma in
    // text values; this is what ical-generator does and what clients
    // expect).
    expect(ics).toContain('LOCATION:תל אביב\\, רחוב הירקון 12');
  });

  it('12) VEVENT brackets exactly once per call (per-task events, no aggregate calendar in B.S6)', () => {
    const ics = svc.generateRequest({
      task: BASE_TASK,
      organizer: ORG,
      attendees: [ATTENDEE_A, ATTENDEE_NO_EMAIL],
    });
    const beginCount = (ics.match(/^BEGIN:VEVENT/gm) ?? []).length;
    const endCount = (ics.match(/^END:VEVENT/gm) ?? []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });
});
