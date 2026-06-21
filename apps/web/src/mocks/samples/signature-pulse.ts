import { type SignaturePulse } from '@emapp/shared-types';

/**
 * SAMPLE_SIGNATURE_PULSE — offline fixture for the board-first home (E2.1).
 *
 * Backs the MSW `GET /org/signature-pulse` handler. The `attention[]` rows are
 * authored ALREADY ranked most-urgent-first (the real BE applies `rankAttention`
 * server-side; offline we hand-order to mirror the wire contract the FE relies
 * on). Project ids reuse SAMPLE_PROJECTS so the ActionCard "open project" links
 * resolve to a real offline project page.
 *
 * Covers each attention reason the home renders — stalled, expiring,
 * consent-gap, not-started — so the offline home exercises every card variant.
 *
 * NO PII: every field is a count, a percentage, a timestamp, or a project's own
 * id/name — schema-parsed by `samples.spec.ts` against `SignaturePulseSchema`.
 */
const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

export const SAMPLE_SIGNATURE_PULSE: SignaturePulse = {
  buckets: { stalled: 1, expiringSoon: 1, needsHuman: 1, onTrack: 2 },
  attention: [
    {
      // stalled — signed before, then went quiet well past the 14d floor.
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      projectName: 'Tama 38/2 — Pilot',
      lastSignatureAt: iso(26 * DAY),
      signedThisWeek: 0,
      stalledDays: 26,
      nextExpiryAt: null,
      expiringSoon: false,
      consentedPct: 64,
      metThreshold: false,
      basis: 'share',
    },
    {
      // expiring — a pending request lapses within the 7d window.
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      projectName: 'פינוי-בינוי הרצליה',
      lastSignatureAt: iso(3 * DAY),
      signedThisWeek: 2,
      stalledDays: 3,
      nextExpiryAt: iso(-2 * DAY),
      expiringSoon: true,
      consentedPct: 71,
      metThreshold: false,
      basis: 'share',
    },
  ],
  needsHuman: [
    {
      projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      projectName: 'Tama 38/2 — Pilot',
      reasons: ['stalled'],
      count: 4,
    },
  ],
  // HB-1 — kill-switch ON in the default fixture (the one-tap remind action is
  // live offline).
  sendEnabled: true,
};

/** All-clear variant — used by an MSW per-test override / story to exercise the
 *  calm reward empty-state (nothing in `attention`). */
export const SAMPLE_SIGNATURE_PULSE_ALL_CLEAR: SignaturePulse = {
  buckets: { stalled: 0, expiringSoon: 0, needsHuman: 0, onTrack: 4 },
  attention: [],
  needsHuman: [],
  sendEnabled: true,
};
