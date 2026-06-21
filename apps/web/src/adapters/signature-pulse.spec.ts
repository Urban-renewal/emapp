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

import { FLEET_TILE_CAP, PULSE_CARD_LIMIT, toSignaturePulseViewModel } from './signature-pulse';

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
    campaignDocumentId: null,
    hasCampaign: false,
    ...over,
  };
}

function pulse(
  attention: ProjectPulseRow[],
  buckets?: Partial<SignaturePulse['buckets']>,
  sendEnabled = true,
): SignaturePulse {
  return {
    buckets: { stalled: 0, expiringSoon: 0, needsHuman: 0, onTrack: 0, ...buckets },
    attention,
    needsHuman: [],
    sendEnabled,
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

  // ── NS-Fleet — the full-fleet tile derivation (ALL in-scope projects) ──

  it('13) fleet maps EVERY in-scope project (not just the top-N cards)', () => {
    const many = Array.from({ length: PULSE_CARD_LIMIT + 6 }, (_, i) =>
      row({ projectId: `p${i}` }),
    );
    const vm = toSignaturePulseViewModel(pulse(many));
    // Cards are truncated to the limit, but the fleet carries ALL of them.
    expect(vm.cards).toHaveLength(PULSE_CARD_LIMIT);
    expect(vm.fleet).toHaveLength(PULSE_CARD_LIMIT + 6);
    expect(vm.fleetCapped).toBe(false);
  });

  it('14) fleet preserves the server (most-urgent-first) order', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'b' }), row({ projectId: 'a' }), row({ projectId: 'c' })]),
    );
    expect(vm.fleet.map((p) => p.projectId)).toEqual(['b', 'a', 'c']);
  });

  it('15) fleet tile state: stalled → danger, expiring → warning, met → success', () => {
    const vm = toSignaturePulseViewModel(
      pulse([
        row({ projectId: 'stalled', stalledDays: PULSE_STALLED_DAYS + 1 }),
        row({ projectId: 'expiring', stalledDays: 2, expiringSoon: true }),
        row({ projectId: 'met', consentedPct: 90, metThreshold: true }),
      ]),
    );
    const byId = Object.fromEntries(vm.fleet.map((p) => [p.projectId, p]));
    expect(byId['stalled']).toMatchObject({ state: 'stalled', intent: 'danger' });
    expect(byId['expiring']).toMatchObject({ state: 'expiring', intent: 'warning' });
    expect(byId['met']).toMatchObject({ state: 'met', intent: 'success' });
  });

  it('16) fleet tile state: a calm on-track project (consent, no flag, not met) → info', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', stalledDays: 1, consentedPct: 40, metThreshold: false })]),
    );
    expect(vm.fleet[0]).toMatchObject({ state: 'onTrack', intent: 'info' });
  });

  it('17) fleet tile state: never-signed 0% → notStarted (neutral)', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', stalledDays: null, consentedPct: 0 })]),
    );
    expect(vm.fleet[0]).toMatchObject({ state: 'notStarted', intent: 'neutral' });
  });

  it('18) fleet marks projects that ALSO appear as attention cards (isOnBoard)', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'carded' }), row({ projectId: 'tail' })], undefined, true),
      1, // only the first row becomes a card
    );
    const byId = Object.fromEntries(vm.fleet.map((p) => [p.projectId, p]));
    expect(byId['carded']?.isOnBoard).toBe(true);
    expect(byId['tail']?.isOnBoard).toBe(false);
    // The full fleet still shows BOTH — the rest is visible, not hidden.
    expect(vm.fleet).toHaveLength(2);
  });

  it('19) fleet caps at FLEET_TILE_CAP and flags fleetCapped for a large org', () => {
    const many = Array.from({ length: FLEET_TILE_CAP + 5 }, (_, i) => row({ projectId: `p${i}` }));
    const vm = toSignaturePulseViewModel(pulse(many));
    expect(vm.fleet).toHaveLength(FLEET_TILE_CAP);
    expect(vm.fleetCapped).toBe(true);
  });

  it('20) fleet strips bidi-override codepoints from the tile name', () => {
    const vm = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', projectName: 'Safe\u202EEvil' })]),
    );
    expect(vm.fleet[0]?.projectName).not.toContain('\u202E');
  });

  it('12) HB-5: campaignDocumentId + hasCampaign carried through verbatim', () => {
    const withCampaign = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p1', campaignDocumentId: 'doc-7', hasCampaign: true })]),
    );
    expect(withCampaign.cards[0]?.campaignDocumentId).toBe('doc-7');
    expect(withCampaign.cards[0]?.hasCampaign).toBe(true);

    const noCampaign = toSignaturePulseViewModel(
      pulse([row({ projectId: 'p2', campaignDocumentId: null, hasCampaign: false })]),
    );
    expect(noCampaign.cards[0]?.campaignDocumentId).toBeNull();
    expect(noCampaign.cards[0]?.hasCampaign).toBe(false);
  });
});
