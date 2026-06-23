/**
 * #509 re-red-team — the EXACTLY-ONCE classification boundary.
 *
 * `classifyNonDelivery` decides whether a non-delivering reminder attempt is
 *   - `definite`  (provably did NOT send) → ledger `failed` → RE-CLAIMABLE (retry)
 *   - `ambiguous` (MAY have sent)         → ledger `pending_send` → PARKED, never
 *                                            auto-resent
 *
 * The original H1 fix (#506/#509) flattened transport-ambiguous SMS failures
 * (network throw / HTTP 5xx / timeout) into the SAME `*_rejected` bucket as a
 * genuine structural decline, so the classifier called them `definite` → the
 * Governor re-claimed + re-sent → DOUBLE SMS (real money). This spec pins the
 * fail-safe contract: ONLY a positively-recognized structural/not-attempted
 * reason is `definite`; everything transport-level OR unrecognized → `ambiguous`.
 *
 * Pure unit — no DB, no providers. Builds `SignatureDeliveryReport` fixtures and
 * asserts the (failureKind, failureCode) verdict.
 */
import type { SignatureDeliveryReport } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { classifyNonDelivery } from './signature-requests.service';

type Channel = SignatureDeliveryReport['sms'];

const unavailable = (reason: string): Channel => ({ available: false, reason });
/** A channel with no reason set (not part of a non-delivery). */
const blank: Channel = { available: false };

function report(over: Partial<SignatureDeliveryReport>): SignatureDeliveryReport {
  return {
    email: blank,
    whatsapp: blank,
    sms: blank,
    ...over,
  };
}

describe('classifyNonDelivery — transport (ambiguous) vs structural (definite)', () => {
  // ── AMBIGUOUS: anything that MAY have dispatched is parked, never auto-resent ──
  it('sms_send_failed (transport throw / 5xx / timeout) → AMBIGUOUS', () => {
    const v = classifyNonDelivery(report({ sms: unavailable('sms_send_failed') }));
    expect(v.failureKind).toBe('ambiguous');
    expect(v.failureCode).toBe('provider_send_failed');
  });

  it('email_send_failed → AMBIGUOUS', () => {
    const v = classifyNonDelivery(report({ email: unavailable('email_send_failed') }));
    expect(v.failureKind).toBe('ambiguous');
  });

  it('a *_ambiguous reason → AMBIGUOUS', () => {
    const v = classifyNonDelivery(report({ sms: unavailable('sms_ambiguous') }));
    expect(v.failureKind).toBe('ambiguous');
  });

  it('MIXED: a structural reject on one channel + a transport throw on another → AMBIGUOUS (safe side wins)', () => {
    // The throw could have dispatched on SMS even though email structurally
    // rejected — the whole attempt must NOT be re-claimable.
    const v = classifyNonDelivery(
      report({
        email: unavailable('email_rejected'),
        sms: unavailable('sms_send_failed'),
      }),
    );
    expect(v.failureKind).toBe('ambiguous');
  });

  it('an UNRECOGNIZED reason → AMBIGUOUS (fail-safe; never inferred definite)', () => {
    const v = classifyNonDelivery(report({ sms: unavailable('totally_new_reason_v2') }));
    expect(v.failureKind).toBe('ambiguous');
    expect(v.failureCode).toBe('provider_unknown');
  });

  it('a structural decline MIXED with an unrecognized reason → AMBIGUOUS', () => {
    const v = classifyNonDelivery(
      report({
        sms: unavailable('sms_rejected'),
        email: unavailable('some_future_reason'),
      }),
    );
    expect(v.failureKind).toBe('ambiguous');
  });

  // ── DEFINITE: provably did NOT send → re-claimable (the preserved H1 gain) ─────
  it('sms_rejected (structural decline — invalid number) → DEFINITE (re-claimable retry)', () => {
    const v = classifyNonDelivery(report({ sms: unavailable('sms_rejected') }));
    expect(v.failureKind).toBe('definite');
    expect(v.failureCode).toBe('provider_rejected');
  });

  it('email_rejected (structural) → DEFINITE', () => {
    const v = classifyNonDelivery(report({ email: unavailable('email_rejected') }));
    expect(v.failureKind).toBe('definite');
  });

  it('a *_declined structural reason → DEFINITE', () => {
    const v = classifyNonDelivery(report({ sms: unavailable('sms_declined') }));
    expect(v.failureKind).toBe('definite');
  });

  it('a structural reject + a NOT-ATTEMPTED channel → DEFINITE', () => {
    const v = classifyNonDelivery(
      report({
        sms: unavailable('sms_rejected'),
        email: unavailable('no_email_on_file'),
      }),
    );
    expect(v.failureKind).toBe('definite');
    expect(v.failureCode).toBe('provider_rejected');
  });

  it('EVERY channel not-attempted (no email, no phone) → DEFINITE no_channel_available', () => {
    const v = classifyNonDelivery(
      report({
        email: unavailable('no_email_on_file'),
        sms: unavailable('no_phone_on_file'),
        whatsapp: unavailable('no_phone_on_file_or_unparseable'),
      }),
    );
    expect(v.failureKind).toBe('definite');
    expect(v.failureCode).toBe('no_channel_available');
  });
});
