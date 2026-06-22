/**
 * `ReminderCadence` policy tests (Autonomous Master Plan, Phase 2). Pure unit
 * tests, ZERO infra — the cadence is a pure clock-injected decision.
 *
 * Covers: the +3/+7/+14 schedule, the max-3 cap, the not-due reasons
 * (not-pending / expired / too-soon / max-reached), and the cadence STEP that
 * feeds the M1 idempotency key.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_REMINDERS,
  REMINDER_CADENCE_DAYS,
  decideReminderCadence,
  type ReminderCadenceInput,
} from './reminder-cadence';

const NOW = new Date('2026-06-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const FUTURE = new Date(NOW.getTime() + 30 * DAY); // link not expired

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

function base(overrides: Partial<ReminderCadenceInput> = {}): ReminderCadenceInput {
  return {
    status: 'pending',
    lastContactAt: daysAgo(0),
    remindersSent: 0,
    expiresAt: FUTURE,
    ...overrides,
  };
}

describe('decideReminderCadence', () => {
  it('NOT due when fewer than +3 days since last contact', () => {
    const d = decideReminderCadence(base({ lastContactAt: daysAgo(2) }), NOW);
    expect(d.due).toBe(false);
    if (!d.due) expect(d.reason).toBe('too_soon');
  });

  it('DUE at step 0 (+3d) after 3 days with no reminders sent', () => {
    const d = decideReminderCadence(base({ lastContactAt: daysAgo(3), remindersSent: 0 }), NOW);
    expect(d.due).toBe(true);
    if (d.due) {
      expect(d.cadenceStep).toBe(0);
      expect(d.cadenceDays).toBe(REMINDER_CADENCE_DAYS[0]);
    }
  });

  it('DUE at step 1 (+7d) once 1 reminder already sent and 7 days elapsed', () => {
    const d = decideReminderCadence(base({ lastContactAt: daysAgo(7), remindersSent: 1 }), NOW);
    expect(d.due).toBe(true);
    if (d.due) expect(d.cadenceStep).toBe(1);
  });

  it('NOT due at step 1 if only 4 days elapsed since the last reminder', () => {
    const d = decideReminderCadence(base({ lastContactAt: daysAgo(4), remindersSent: 1 }), NOW);
    expect(d.due).toBe(false);
    if (!d.due) expect(d.reason).toBe('too_soon');
  });

  it('DUE at step 2 (+14d) once 2 reminders sent and 14 days elapsed', () => {
    const d = decideReminderCadence(base({ lastContactAt: daysAgo(14), remindersSent: 2 }), NOW);
    expect(d.due).toBe(true);
    if (d.due) expect(d.cadenceStep).toBe(2);
  });

  it('caps at MAX_REMINDERS — never due after the last step is spent', () => {
    const d = decideReminderCadence(
      base({ lastContactAt: daysAgo(60), remindersSent: MAX_REMINDERS }),
      NOW,
    );
    expect(d.due).toBe(false);
    if (!d.due) expect(d.reason).toBe('max_reminders_reached');
  });

  it('NOT due for a non-pending request', () => {
    const d = decideReminderCadence(base({ status: 'signed', lastContactAt: daysAgo(10) }), NOW);
    expect(d.due).toBe(false);
    if (!d.due) expect(d.reason).toBe('not_pending');
  });

  it('NOT due for an expired link (re-issue, not remind)', () => {
    const d = decideReminderCadence(
      base({ lastContactAt: daysAgo(10), expiresAt: daysAgo(1) }),
      NOW,
    );
    expect(d.due).toBe(false);
    if (!d.due) expect(d.reason).toBe('expired');
  });
});
