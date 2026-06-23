/**
 * `ReminderCadence` — the cadence policy (Autonomous Master Plan, Phase 2; top
 * autonomy win #1 "reminder cadence by rule, day 0/+3/+7/+14").
 *
 * A PURE decision: given a pending signature request's timing facts + an injected
 * `now`, decide whether it is DUE for a reminder and, if so, at which cadence
 * STEP. The recommender uses this to DETECT due requests (set-based); the step
 * feeds the M1 idempotency key (recipient + cadence_step — NOT proposal_id, so
 * the key is stable across re-proposals of the same recipient+step) so each step
 * is sent at most once.
 *
 * No DB, no zod, no node: — FE-safe + pure + fully unit-testable with an injected
 * clock, exactly like `autonomy-policy` + `outbound-policy`.
 *
 * ── The cadence ─────────────────────────────────────────────────────────────
 * Reminders are due at +3, +7, +14 days after the request's last contact. (Day 0
 * is the original send — not a reminder.) A request gets at most `maxReminders`
 * (=3) reminders. A request that is signed / cancelled / expired is NOT due (the
 * recommender pre-filters to `pending`, but the policy is defensive). The "days
 * since last contact" is measured from `lastContactAt` (the original send or the
 * most recent reminder), so the cadence advances as reminders go out.
 */

/** The cadence offsets (days since last contact) at which a reminder is due. The
 *  INDEX into this array is the cadence STEP (0 → +3, 1 → +7, 2 → +14). */
export const REMINDER_CADENCE_DAYS = [3, 7, 14] as const;

/** Max reminders per request (the no-nag cap, charter §5). Equals the cadence
 *  length — once all steps are spent, the request is no longer due. */
export const MAX_REMINDERS = REMINDER_CADENCE_DAYS.length;

/** The timing facts the cadence needs. All NON-PII. */
export interface ReminderCadenceInput {
  /** The request lifecycle state. Only `pending` is ever due. */
  status: string;
  /** When the request was last contacted (original send or last reminder). The
   *  cadence clock. */
  lastContactAt: Date;
  /** How many reminders have already gone out for this request. */
  remindersSent: number;
  /** When the request's signing link expires — a request past/at expiry is not a
   *  reminder candidate (re-issue, not remind). */
  expiresAt: Date;
}

/** The cadence verdict. `due:false` → not (yet) a reminder candidate. `due:true`
 *  carries the STEP (0-based, into REMINDER_CADENCE_DAYS) the M1 key uses. */
export type ReminderCadenceDecision =
  | { due: false; reason: ReminderNotDueReason }
  | { due: true; cadenceStep: number; cadenceDays: number };

export type ReminderNotDueReason = 'not_pending' | 'expired' | 'max_reminders_reached' | 'too_soon';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether a signature request is due for a reminder right now.
 *
 * A request is DUE iff: it is `pending`, not past expiry, has reminders left
 * (`remindersSent < MAX_REMINDERS`), AND at least `REMINDER_CADENCE_DAYS[step]`
 * days have elapsed since `lastContactAt`, where `step = remindersSent` (the next
 * unspent step). PURE given `now`.
 */
export function decideReminderCadence(
  input: ReminderCadenceInput,
  now: Date,
): ReminderCadenceDecision {
  if (input.status !== 'pending') return { due: false, reason: 'not_pending' };
  if (now.getTime() >= input.expiresAt.getTime()) return { due: false, reason: 'expired' };
  if (input.remindersSent >= MAX_REMINDERS) {
    return { due: false, reason: 'max_reminders_reached' };
  }

  const step = input.remindersSent; // the next unspent cadence step
  const dueDays = REMINDER_CADENCE_DAYS[step];
  if (dueDays === undefined) return { due: false, reason: 'max_reminders_reached' };

  const elapsedMs = now.getTime() - input.lastContactAt.getTime();
  if (elapsedMs < dueDays * DAY_MS) return { due: false, reason: 'too_soon' };

  return { due: true, cadenceStep: step, cadenceDays: dueDays };
}
