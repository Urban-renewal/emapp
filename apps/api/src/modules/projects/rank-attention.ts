import {
  PULSE_EXPIRING_SOON_DAYS,
  PULSE_STALLED_DAYS,
  type ProjectPulseRow,
} from '@emapp/shared-types';

/**
 * E2 Wave-2 A2 — the `rankAttention` PURE scorer (the `RuleDecisionProvider`
 * seam, deterministic — NO LLM). It orders the org-wide signature-pulse feed so
 * the project that most needs a human's attention floats to the top of the
 * board-first home (E2.1).
 *
 * Why a plain, dependency-free function (not a service):
 *  - DETERMINISTIC + side-effect-free → trivially unit-testable (the ordering is
 *    asserted in `org-signature-pulse.spec.ts`) and identical on every call.
 *  - It is the explicit SEAM where a smarter (e.g. learned) ranker could later
 *    slot in behind the same `(rows) => rows` shape — today it is a transparent
 *    rule, which is what an urban-renewal coordinator can reason about.
 *  - It consumes ONLY the already-computed, PII-free `ProjectPulseRow` fields,
 *    so the scorer can never touch owner PII (there is none in its input).
 *
 * ── THE RULE (weighted urgency, higher = more urgent) ─────────────────────────
 * A project's score is the SUM of three independent pressure signals:
 *
 *  1. STALL pressure — a stalled project (signed before, then went quiet) is the
 *     loudest signal: nobody is moving it. Score rises with how long it has been
 *     stalled, but only past the `PULSE_STALLED_DAYS` floor (a 2-day-quiet
 *     project is normal, not stalled). A project that has NEVER had a signature
 *     (`stalledDays === null`) is NOT treated as stalled here — it is "not
 *     started", a different (lower-urgency) state, so it scores 0 on this axis.
 *
 *  2. EXPIRY pressure — a pending request about to lapse is time-critical: if it
 *     expires the owner must be re-invited. `expiringSoon` (within
 *     `PULSE_EXPIRING_SOON_DAYS`) adds a fixed, high weight.
 *
 *  3. CONSENT-GAP pressure — the further a project is from its target, the more
 *     work remains. A project that has already MET its threshold scores 0 on
 *     this axis (it is effectively done — surface it last). The gap is
 *     `targetGap = max(0, 100 - consentedPct)` while `metThreshold` is false.
 *
 * Ties break DETERMINISTICALLY by `projectId` (ascending) so the wire order is
 * stable across calls and machines — a flake-free assertion target.
 *
 * The exact weights are deliberately simple, owner-tunable constants; the GATE
 * is the RELATIVE ordering they produce (asserted in the spec), not the
 * absolute numbers. They do not encode any statutory/legal claim — that lives
 * behind the consent `basis` label upstream.
 */

/** Stalled-pressure: linear in days-past-floor, capped so one ancient project
 *  can't dwarf every other signal. */
const STALL_WEIGHT = 4;
const STALL_DAYS_CAP = 60; // a project stalled > floor+60d is "maximally stalled".

/** Expiry-pressure: a single fixed, high bump (binary signal). */
const EXPIRY_WEIGHT = 50;

/** Consent-gap pressure: linear in the % short of target. */
const CONSENT_GAP_WEIGHT = 0.5;

/** PUBLIC for the spec — the urgency score for ONE row. Higher = more urgent. */
export function attentionScore(row: ProjectPulseRow): number {
  let score = 0;

  // 1. Stall pressure — only counts a row that HAS signed before (stalledDays
  //    non-null) AND is past the stalled floor. A never-signed row (null) is
  //    "not started", not "stalled" → 0 here.
  if (row.stalledDays !== null && row.stalledDays >= PULSE_STALLED_DAYS) {
    const over = Math.min(row.stalledDays - PULSE_STALLED_DAYS, STALL_DAYS_CAP);
    score += STALL_WEIGHT * over;
  }

  // 2. Expiry pressure — a pending request lapsing soon.
  if (row.expiringSoon) score += EXPIRY_WEIGHT;

  // 3. Consent-gap pressure — distance from target, zero once the threshold is
  //    met (a met project is least urgent).
  if (!row.metThreshold) {
    const gap = Math.max(0, 100 - row.consentedPct);
    score += CONSENT_GAP_WEIGHT * gap;
  }

  return score;
}

/**
 * Orders `rows` most-urgent-first by {@link attentionScore}, with a stable
 * `projectId`-ascending tie-break. Pure: returns a NEW array, never mutates the
 * input (callers pass freshly-built rows, but non-mutation keeps it safe to
 * reuse the input elsewhere).
 */
export function rankAttention(rows: readonly ProjectPulseRow[]): ProjectPulseRow[] {
  return [...rows].sort((a, b) => {
    const diff = attentionScore(b) - attentionScore(a); // DESC by urgency
    if (diff !== 0) return diff;
    return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
  });
}

/** Re-export the tunables the scorer reads so a caller/test can reference the
 *  exact floor/window without re-importing from shared-types. */
export { PULSE_EXPIRING_SOON_DAYS, PULSE_STALLED_DAYS };
