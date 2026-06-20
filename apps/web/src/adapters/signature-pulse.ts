import { PULSE_STALLED_DAYS, type ProjectPulseRow, type SignaturePulse } from '@emapp/shared-types';

import { stripBidiOverrides } from '@/lib/bidi';
import type {
  PulseActionCardViewModel,
  PulseReason,
  SignaturePulseViewModel,
} from '@/models/signature-pulse.vm';

/**
 * Wire → ViewModel adapter for the board-first home (E2 Wave-2 E2.1). Pure
 * function — no I/O, no hooks; runs inside TanStack's `select` so the home
 * component only ever sees the pre-derived `SignaturePulseViewModel`.
 *
 * What it derives (so components stay presentational):
 *  - the per-card top-priority REASON, using the SAME precedence the server's
 *    `rankAttention` weights by (stalled > expiring > consent-gap), plus a
 *    distinct "not started" state for a project that has never had a signature
 *    (the scorer treats null `stalledDays` as not-stalled, a lower-urgency
 *    state — we surface it honestly rather than mislabel it "stalled"),
 *  - the status-chip `intent` for that reason,
 *  - the all-clear reward flag.
 *
 * Order is PRESERVED: `attention[]` is already ranked most-urgent-first by the
 * server; we map + truncate to the first `limit`, never re-sort. The bidi strip
 * on the project name mirrors every other free-text field (§SEC-M4 / RTL-spoof).
 *
 * NO PII is present on the wire — only counts, percentages, timestamps, and the
 * project's own id/name.
 */

/** Default cap — the home shows the ~5 that need you now (North-Star triage). */
export const PULSE_CARD_LIMIT = 5;

/** Derive the single top-priority reason a project surfaced, mirroring the
 *  server scorer's precedence so the FE label matches WHY it ranked. */
function deriveReason(row: ProjectPulseRow): PulseReason {
  // Stalled wins: it has signed before AND gone quiet past the floor.
  if (row.stalledDays !== null && row.stalledDays >= PULSE_STALLED_DAYS) {
    return 'stalled';
  }
  // Then a pending request about to lapse.
  if (row.expiringSoon) return 'expiring';
  // A project that never had a signature is "not started" (distinct, calmer
  // than "stalled"); the scorer also treats null `stalledDays` as not-stalled.
  if (row.stalledDays === null && row.consentedPct === 0) return 'notStarted';
  // Otherwise it's here for the consent gap (still short of target).
  return 'consentGap';
}

const REASON_INTENT: Record<PulseReason, PulseActionCardViewModel['intent']> = {
  stalled: 'danger',
  expiring: 'warning',
  consentGap: 'warning',
  notStarted: 'neutral',
};

function toCard(row: ProjectPulseRow): PulseActionCardViewModel {
  const reason = deriveReason(row);
  return {
    projectId: row.projectId,
    projectName: stripBidiOverrides(row.projectName),
    reason,
    intent: REASON_INTENT[reason],
    stalledDays: row.stalledDays,
    consentedPct: row.consentedPct,
    basis: row.basis,
    metThreshold: row.metThreshold,
  };
}

export function toSignaturePulseViewModel(
  wire: SignaturePulse,
  limit: number = PULSE_CARD_LIMIT,
): SignaturePulseViewModel {
  const cards = wire.attention.slice(0, limit).map(toCard);
  const { stalled, expiringSoon, needsHuman, onTrack } = wire.buckets;
  const totalInScope = stalled + expiringSoon + needsHuman + onTrack;
  return {
    buckets: { stalled, expiringSoon, needsHuman, onTrack },
    cards,
    // All-clear = nothing the server flagged for attention. We key off the
    // ranked feed (the source of the cards) rather than the buckets so the
    // reward state and the card list can never disagree.
    isAllClear: wire.attention.length === 0,
    totalInScope,
  };
}
