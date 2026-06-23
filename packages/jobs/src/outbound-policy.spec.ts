/**
 * `OutboundPolicy` gate-pipeline tests (Autonomous Master Plan, Phase 2; design
 * correction H-solid). Pure unit tests, ZERO infra — every gate is a pure,
 * clock-injected decision, so the whole pipeline is testable without a DB.
 *
 * Covers each gate independently (KillSwitch / Consent / CircuitBreaker /
 * QuietHours incl. clock cases / RateCeiling) + the pipeline short-circuit order.
 */
import { describe, expect, it } from 'vitest';

import {
  CircuitBreaker,
  ConsentGate,
  DEFAULT_OUTBOUND_GATES,
  DEFAULT_OUTBOUND_POLICY_CONFIG,
  KillSwitchGate,
  QuietHoursGate,
  RateCeilingGate,
  evaluateOutboundPolicy,
  isWithinQuietHours,
  jerusalemHour,
  type GateContext,
  type OutboundRequest,
  type OutboundSnapshot,
} from './outbound-policy';

const REQ: OutboundRequest = {
  orgId: '00000000-0000-0000-0000-000000000001',
  channel: 'email',
  recipientRef: 'req-1',
  cadenceStep: 0,
};

/** A snapshot where EVERY gate would allow — tests flip one fact at a time. */
function allowSnapshot(): OutboundSnapshot {
  return {
    killSwitchEnabled: true,
    recipientConsented: true,
    recipientSendsInWindow: 0,
    orgSendsInWindow: 0,
    breakerTripped: false,
  };
}

/** A daytime instant in Asia/Jerusalem so QuietHoursGate allows by default. */
const DAYTIME = new Date('2026-06-22T09:00:00.000Z'); // 12:00 Jerusalem (UTC+3)

function ctx(snapshot: OutboundSnapshot, now: Date = DAYTIME): GateContext {
  return { now, snapshot, config: DEFAULT_OUTBOUND_POLICY_CONFIG };
}

describe('KillSwitchGate', () => {
  it('allows when the kill-switch is enabled', () => {
    expect(KillSwitchGate(REQ, ctx(allowSnapshot())).verdict).toBe('allow');
  });
  it('DENIES when the kill-switch is off', () => {
    const s = allowSnapshot();
    s.killSwitchEnabled = false;
    const v = KillSwitchGate(REQ, ctx(s));
    expect(v.verdict).toBe('deny');
    expect(v.reason).toBe('kill_switch_off');
  });
});

describe('ConsentGate', () => {
  it('allows a consented recipient', () => {
    expect(ConsentGate(REQ, ctx(allowSnapshot())).verdict).toBe('allow');
  });
  it('DENIES a recipient who withdrew consent', () => {
    const s = allowSnapshot();
    s.recipientConsented = false;
    expect(ConsentGate(REQ, ctx(s)).reason).toBe('consent_withdrawn');
  });
});

describe('CircuitBreaker', () => {
  it('allows when not tripped', () => {
    expect(CircuitBreaker(REQ, ctx(allowSnapshot())).verdict).toBe('allow');
  });
  it('DENIES when tripped (PAUSE-only)', () => {
    const s = allowSnapshot();
    s.breakerTripped = true;
    expect(CircuitBreaker(REQ, ctx(s)).reason).toBe('breaker_tripped');
  });
});

describe('isWithinQuietHours (pure clock math)', () => {
  it('wrapping window 21..8 includes night + early morning, excludes midday', () => {
    expect(isWithinQuietHours(22, 21, 8)).toBe(true); // 22:00 — quiet
    expect(isWithinQuietHours(2, 21, 8)).toBe(true); // 02:00 — quiet
    expect(isWithinQuietHours(7, 21, 8)).toBe(true); // 07:00 — quiet
    expect(isWithinQuietHours(8, 21, 8)).toBe(false); // 08:00 — boundary, awake
    expect(isWithinQuietHours(12, 21, 8)).toBe(false); // noon — awake
    expect(isWithinQuietHours(21, 21, 8)).toBe(true); // 21:00 — boundary, quiet
  });
  it('same-day window 1..5', () => {
    expect(isWithinQuietHours(3, 1, 5)).toBe(true);
    expect(isWithinQuietHours(0, 1, 5)).toBe(false);
    expect(isWithinQuietHours(5, 1, 5)).toBe(false);
  });
  it('empty window (start==end) is never quiet', () => {
    expect(isWithinQuietHours(3, 3, 3)).toBe(false);
  });
});

describe('jerusalemHour (DST-correct via Intl)', () => {
  it('maps a UTC instant to the Asia/Jerusalem local hour', () => {
    // 2026-06-22 is summer → Jerusalem is UTC+3 (IDT).
    expect(jerusalemHour(new Date('2026-06-22T09:00:00Z'))).toBe(12);
    // 22:00 UTC → 01:00 next day Jerusalem.
    expect(jerusalemHour(new Date('2026-06-22T22:00:00Z'))).toBe(1);
  });
});

describe('QuietHoursGate', () => {
  it('allows during the day', () => {
    // 09:00 UTC = 12:00 Jerusalem → awake.
    expect(QuietHoursGate(REQ, ctx(allowSnapshot())).verdict).toBe('allow');
  });
  it('DEFERS (not denies) at night Jerusalem time', () => {
    // 23:00 UTC = 02:00 Jerusalem → quiet.
    const night = new Date('2026-06-22T23:00:00.000Z');
    const v = QuietHoursGate(REQ, ctx(allowSnapshot(), night));
    expect(v.verdict).toBe('defer');
    expect(v.reason).toBe('quiet_hours');
  });
});

describe('RateCeilingGate', () => {
  it('allows below ceilings', () => {
    expect(RateCeilingGate(REQ, ctx(allowSnapshot())).verdict).toBe('allow');
  });
  it('DENIES at the per-recipient ceiling (no-nag)', () => {
    const s = allowSnapshot();
    s.recipientSendsInWindow = DEFAULT_OUTBOUND_POLICY_CONFIG.maxPerRecipient;
    expect(RateCeilingGate(REQ, ctx(s)).reason).toBe('recipient_ceiling');
  });
  it('DENIES at the per-org ceiling (send-bomb guard)', () => {
    const s = allowSnapshot();
    s.orgSendsInWindow = DEFAULT_OUTBOUND_POLICY_CONFIG.maxPerOrg;
    expect(RateCeilingGate(REQ, ctx(s)).reason).toBe('org_ceiling');
  });
});

describe('evaluateOutboundPolicy (pipeline)', () => {
  it('allows when every gate allows', () => {
    const d = evaluateOutboundPolicy(REQ, ctx(allowSnapshot()), DEFAULT_OUTBOUND_GATES);
    expect(d.verdict).toBe('allow');
  });
  it('short-circuits on the FIRST non-allow gate (kill-switch beats quiet-hours)', () => {
    const s = allowSnapshot();
    s.killSwitchEnabled = false;
    // Even at night, the kill-switch (earlier in the pipeline) reports first.
    const night = new Date('2026-06-22T23:00:00.000Z');
    const d = evaluateOutboundPolicy(REQ, ctx(s, night), DEFAULT_OUTBOUND_GATES);
    expect(d.verdict).toBe('deny');
    expect(d.reason).toBe('kill_switch_off');
  });
  it('defers when only quiet-hours blocks', () => {
    const night = new Date('2026-06-22T23:00:00.000Z');
    const d = evaluateOutboundPolicy(REQ, ctx(allowSnapshot(), night), DEFAULT_OUTBOUND_GATES);
    expect(d.verdict).toBe('defer');
  });
  it('an empty gate list allows', () => {
    expect(evaluateOutboundPolicy(REQ, ctx(allowSnapshot()), []).verdict).toBe('allow');
  });
});
