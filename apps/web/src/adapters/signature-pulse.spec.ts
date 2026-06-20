/**
 * E2 Wave-2 E2.1 — signature-pulse adapter (Wire → ViewModel) unit test.
 *
 * The adapter is the single seam that derives the per-card REASON (mirroring
 * the server scorer's stalled > expiring > consent-gap precedence + a distinct
 * not-started state), the chip intent, the all-clear reward flag, and that
 * PRESERVES the server's most-urgent-first ranking + truncates to the limit.
 * A regression in any of those is a wrong/misleading home — assert them here.
 */
import { PULSE_STALLED_DAYS, type ProjectPulseRow, type SignaturePulse } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { PULSE_CARD_LIMIT, toSignaturePulseViewModel } from './signature-pulse';

function row(over: Partial<ProjectPulseRow> & { projectId: string }): ProjectPulseRow {
  return {
    projectName: `Project ${over.projectId}`,
    lastSignatureAt: null,
    signedThisWeek: 0,
    stalledDays: null,
    nextExpiryAt: null,
    expiringSoon: false,
    consentedPct: 50,
    metThreshold: false,
    basis: 'share',
    ...over,
  };
}

function pulse(
  attention: ProjectPulseRow[],
  buckets?: Partial<SignaturePulse['buckets']>,
): SignaturePulse {
  return {
    buckets: { stalled: 0, expiringSoon: 0, needsHuman: 0, onTrack: 0, ...buckets },
    attention,
    needsHuman: [],
  };
}

describe('toSignaturePulseViewModel — reason derivation + order + all-clear', () => {
  it('1) stalled wins: a past-floor stalledDays row → reason "stalled" + danger intent', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', stalledDays: PULSE_STALLED_DAYS + 5, expiringSoon: true })]),
    );
    expect(vm.cards[0]?.reason).toBe('stalled');
    expect(vm.cards[0]?.intent).toBe('danger');
    expect(vm.cards[0]?.stalledDays).toBe(PULSE_STALLED_DAYS + 5);
  });

  it('2) expiring: not stalled but a pending request lapsing → reason "expiring" + warning', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', stalledDays: 2, expiringSoon: true })]),
    );
    expect(vm.cards[0]?.reason).toBe('expiring');
    expect(vm.cards[0]?.intent).toBe('warning');
  });

  it('3) not-started: never-signed (null stalledDays) + 0% → reason "notStarted" + neutral', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', stalledDays: null, consentedPct: 0 })]),
    );
    expect(vm.cards[0]?.reason).toBe('notStarted');
    expect(vm.cards[0]?.intent).toBe('neutral');
  });

  it('4) consent-gap: has consent but short of target, not stalled/expiring → "consentGap"', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', stalledDays: null, consentedPct: 55 })]),
    );
    expect(vm.cards[0]?.reason).toBe('consentGap');
    expect(vm.cards[0]?.intent).toBe('warning');
  });

  it('5) PRESERVES server order (no re-sort) — wire order is the ranked order', () => {
    const vm = toSignaturePulseViewModel(
      pulse([
        row({ projectId: 'b-most-urgent' }),
        row({ projectId: 'a-less-urgent' }),
        row({ projectId: 'c-least' }),
      ]),
    );
    expect(vm.cards.map((c) => c.projectId)).toEqual(['b-most-urgent', 'a-less-urgent', 'c-least']);
  });

  it('6) truncates to the card limit', () => {
    const many = Array.from({ length: PULSE_CARD_LIMIT + 4 }, (_, i) =>
      row({ projectId: `p${i}` }),
    );
    const vm = toSignaturePulseViewModel(pulse(many));
    expect(vm.cards).toHaveLength(PULSE_CARD_LIMIT);
    const custom = toSignaturePulseViewModel(pulse(many), 2);
    expect(custom.cards).toHaveLength(2);
  });

  it('7) all-clear: empty attention → isAllClear true (the reward state)', () => {
    const vm = toSignaturePulseViewModel(pulse([], { onTrack: 4 }));
    expect(vm.isAllClear).toBe(true);
    expect(vm.cards).toHaveLength(0);
    expect(vm.totalInScope).toBe(4);
  });

  it('8) non-empty attention → isAllClear false', () => {
    const vm = toSignaturePulseViewModel(pulse([row({ projectId: 'p1' })]));
    expect(vm.isAllClear).toBe(false);
  });

  it('9) totalInScope sums the four mutually-exclusive buckets', () => {
    const vm = toSignaturePulseViewModel(
      pulse([], { stalled: 1, expiringSoon: 2, needsHuman: 1, onTrack: 3 }),
    );
    expect(vm.totalInScope).toBe(7);
  });

  it('10) consent % + basis carried through verbatim (the mandatory basis label source)', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', consentedPct: 73, basis: 'share' })]),
    );
    expect(vm.cards[0]?.consentedPct).toBe(73);
    expect(vm.cards[0]?.basis).toBe('share');
  });

  it('11) strips bidi-override codepoints from the project name (RTL-spoof defense)', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', projectName: 'Safe\u202EEvil' })]),
    );
    expect(vm.cards[0]?.projectName).not.toContain('\u202E');
  });
});
