/**
 * Delivery-outcome honesty (#2/#16) — the CANONICAL `didAnyChannelDeliver`
 * predicate is the SINGLE SOURCE OF TRUTH for "did a channel actually carry the
 * signing link?". Both the BE tallies (bulk/campaign/remind summaries,
 * reissueAndDeliver) and the FE per-name holdout chase toast derive their
 * delivered-vs-no-channel honesty from THIS one definition — so it must never
 * report a re-mint that reached no channel as "sent".
 *
 * This spec is the contract: a channel "went" iff it is `available` AND its
 * status is a real send (`sent`/`queued`/`ready`). Anything else — including a
 * report where EVERY channel is unavailable (owner has no email AND no phone, or
 * PII decrypt failed) — is NOT a delivery.
 */
import { describe, expect, it } from 'vitest';

import {
  didAnyChannelDeliver,
  SignatureDeliveryReportSchema,
  type SignatureDeliveryReport,
} from './signature-request';

const unavailable = { available: false, reason: 'no_channel_on_file' } as const;

function report(over: Partial<SignatureDeliveryReport>): SignatureDeliveryReport {
  return SignatureDeliveryReportSchema.parse({
    email: unavailable,
    sms: unavailable,
    whatsapp: unavailable,
    ...over,
  });
}

describe('didAnyChannelDeliver — the canonical delivery predicate', () => {
  it('email sent → true', () => {
    expect(didAnyChannelDeliver(report({ email: { available: true, status: 'sent' } }))).toBe(true);
  });

  it('sms queued → true', () => {
    expect(didAnyChannelDeliver(report({ sms: { available: true, status: 'queued' } }))).toBe(true);
  });

  it('whatsapp deep-link ready → true', () => {
    expect(didAnyChannelDeliver(report({ whatsapp: { available: true, status: 'ready' } }))).toBe(
      true,
    );
  });

  it('NO channel available (no email AND no phone) → false — never "sent"', () => {
    expect(didAnyChannelDeliver(report({}))).toBe(false);
  });

  it('a channel available but REJECTED (status rejected) → false', () => {
    expect(didAnyChannelDeliver(report({ email: { available: true, status: 'rejected' } }))).toBe(
      false,
    );
  });

  it('available:true but NO status → false (created, not yet sent)', () => {
    expect(didAnyChannelDeliver(report({ email: { available: true } }))).toBe(false);
  });

  it('available:false but a stale status set → false (availability gates the status)', () => {
    expect(didAnyChannelDeliver(report({ sms: { available: false, status: 'sent' } }))).toBe(false);
  });
});
