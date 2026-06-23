/**
 * Proposal adapter (Wire → ViewModel) — Autonomous Master Plan, Phase 1.
 *
 * The Approval Inbox renders these VMs. Two invariants this pins:
 *
 *  1. NO PII in the rendered VM — the charter's PII-free-proposal contract.
 *     Even if a (malformed / hostile) `evidence` snapshot smuggles a
 *     national_id / phone / name, the adapter reads ONLY the kind + scopeType
 *     and never copies `evidence` fields into the VM. Every VM string is
 *     asserted free of the planted PII tokens.
 *
 *  2. VOICE LAW — the `whyTitle` is neutral-passive / user-framed
 *     ("מוצע להנפיק מחדש"), NEVER system-hero voice ("הנפקתי / טיפלתי").
 *     A regression that reintroduces first-person system voice fails here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import type { ProposalApplyDelivery, ProposalView } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toApproveOutcome, toProposalViewModel, toProposalViewModels } from './proposal';

const PLANTED_NATIONAL_ID = '040000018';
const PLANTED_PHONE = '0501234567';
const PLANTED_NAME = 'ישראל ישראלי';

function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    kind: 'signature_request.reissue',
    status: 'pending',
    scopeType: 'signature_request',
    scopeId: '33333333-3333-4333-8333-333333333333',
    evidence: { expiredCount: 1, requestId: '33333333-3333-4333-8333-333333333333' },
    expiresAt: null,
    actorType: 'system',
    createdAt: new Date('2026-06-22T08:00:00.000Z'),
    appliedAt: null,
    ...over,
  };
}

// The Hebrew first-person system-voice verbs the VOICE LAW forbids in copy.
const FORBIDDEN_SYSTEM_VOICE = ['טיפלתי', 'תזמנתי', 'ניתחתי', 'הנפקתי', 'שלחתי'];

describe('toProposalViewModel — Approval-Inbox adapter', () => {
  it('1) composes calm, user-framed copy for the reissue kind (he)', () => {
    const vm = toProposalViewModel(proposal(), 'he');
    expect(vm.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(vm.kind).toBe('signature_request.reissue');
    expect(vm.whyTitle).toBe('בקשת חתימה שפגה — מוצע להנפיק מחדש');
    expect(vm.approveLabel).toBe('אשר הנפקה מחדש');
    expect(vm.scopeLabel).toBe('בקשת חתימה');
  });

  it('2) composes English copy under the en locale', () => {
    const vm = toProposalViewModel(proposal(), 'en');
    expect(vm.whyTitle).toBe('A signature request expired — re-issue suggested');
    expect(vm.approveLabel).toBe('Approve re-issue');
    expect(vm.scopeLabel).toBe('Signature request');
  });

  it('3) VOICE LAW — no first-person system-hero verb in any VM string', () => {
    const vm = toProposalViewModel(proposal(), 'he');
    const strings = [vm.whyTitle, vm.approveLabel, vm.scopeLabel];
    for (const s of strings) {
      for (const banned of FORBIDDEN_SYSTEM_VOICE) {
        expect(s).not.toContain(banned);
      }
    }
  });

  it('4) NO PII — a hostile evidence snapshot never leaks into the VM', () => {
    const vm = toProposalViewModel(
      proposal({
        evidence: {
          // Planted PII the adapter MUST NOT surface (the wire contract says
          // evidence is PII-free; the adapter defends regardless).
          national_id: PLANTED_NATIONAL_ID,
          phone: PLANTED_PHONE,
          ownerName: PLANTED_NAME,
          expiredCount: 2,
        },
      }),
      'he',
    );
    const serialized = JSON.stringify(vm);
    expect(serialized).not.toContain(PLANTED_NATIONAL_ID);
    expect(serialized).not.toContain(PLANTED_PHONE);
    expect(serialized).not.toContain(PLANTED_NAME);
  });

  it('5) an unknown future kind falls back to the safe generic line (never a raw kind / PII)', () => {
    const vm = toProposalViewModel(
      proposal({ kind: 'some.future.kind' as ProposalView['kind'] }),
      'he',
    );
    expect(vm.whyTitle).toBe('הצעה ממתינה לאישורך');
    expect(vm.approveLabel).toBe('אשר');
    // Never render the raw machine kind to the user.
    expect(vm.whyTitle).not.toContain('some.future.kind');
  });

  it('6) toProposalViewModels maps a list preserving order', () => {
    const vms = toProposalViewModels(
      [
        proposal({ id: '11111111-1111-4111-8111-111111111111' }),
        proposal({ id: '44444444-4444-4444-8444-444444444444' }),
      ],
      'he',
    );
    expect(vms.map((v) => v.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
    ]);
  });
});

/**
 * `toApproveOutcome` — the APPROVE legibility contract (G-QA rule #3). Pins the
 * delivery-state → confirmation mapping so a future refactor can't silently let
 * a non-send read as a send.
 *
 * The mapping is honest-by-construction: ONLY `state:'sent'` (with a channel) is
 * a `success` tone; every non-send is `neutral` (already_sent) or `warning`
 * (blocked / failed / ambiguous / no_channel). These tests also pin the i18n
 * keys against BOTH locale JSONs — the inbox resolves these keys via TEMPLATE
 * LITERALS (`t(\`delivery.${messageKey}\`)`), which the static §i18n-key-coverage
 * scanner deliberately skips, so this is the coverage that proves they exist.
 */
function delivery(over: Partial<ProposalApplyDelivery> = {}): ProposalApplyDelivery {
  return { delivered: true, state: 'sent', channel: 'email', recipient: 'na***@x.com', ...over };
}

/** Flatten a nested message JSON to a Set of dotted keys (mirrors the scanner). */
function flattenKeys(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      for (const child of flattenKeys(v, path)) out.add(child);
    } else {
      out.add(path);
    }
  }
  return out;
}

function localeKeys(file: 'he.json' | 'en.json'): Set<string> {
  const raw = readFileSync(join(__dirname, '..', 'messages', file), 'utf8');
  return flattenKeys(JSON.parse(raw));
}

describe('toApproveOutcome — APPROVE delivery legibility', () => {
  it('1) sent + channel + recipient → success, names channel + masked recipient', () => {
    const o = toApproveOutcome(
      delivery({ state: 'sent', channel: 'email', recipient: 'na***@x.com' }),
    );
    expect(o.tone).toBe('success');
    expect(o.messageKey).toBe('sentWithRecipient');
    expect(o.channel).toBe('email');
    expect(o.recipient).toBe('na***@x.com');
  });

  it('2) sent on sms/whatsapp (no recipient) → success, no-recipient copy', () => {
    const sms = toApproveOutcome(delivery({ state: 'sent', channel: 'sms', recipient: null }));
    expect(sms.tone).toBe('success');
    expect(sms.messageKey).toBe('sentNoRecipient');
    const wa = toApproveOutcome(delivery({ state: 'sent', channel: 'whatsapp', recipient: null }));
    expect(wa.messageKey).toBe('sentNoRecipient');
  });

  it('3) sent with NO channel is incoherent → warning/ambiguous, never a false success', () => {
    const o = toApproveOutcome(delivery({ state: 'sent', channel: null, recipient: null }));
    expect(o.tone).toBe('warning');
    expect(o.messageKey).toBe('ambiguous');
  });

  it('4) every non-sent state maps HONESTLY (never success)', () => {
    expect(
      toApproveOutcome(
        delivery({ delivered: false, state: 'already_sent', channel: null, recipient: null }),
      ),
    ).toMatchObject({ tone: 'neutral', messageKey: 'alreadySent' });
    expect(
      toApproveOutcome(
        delivery({ delivered: false, state: 'blocked', channel: null, recipient: null }),
      ),
    ).toMatchObject({ tone: 'warning', messageKey: 'blocked' });
    expect(
      toApproveOutcome(
        delivery({ delivered: false, state: 'no_channel', channel: null, recipient: null }),
      ),
    ).toMatchObject({ tone: 'warning', messageKey: 'noChannel' });
    expect(
      toApproveOutcome(
        delivery({ delivered: false, state: 'failed', channel: null, recipient: null }),
      ),
    ).toMatchObject({ tone: 'warning', messageKey: 'ambiguous' });
    expect(
      toApproveOutcome(
        delivery({ delivered: false, state: 'ambiguous', channel: null, recipient: null }),
      ),
    ).toMatchObject({ tone: 'warning', messageKey: 'ambiguous' });
  });

  it('5) NO non-sent state is ever a success tone', () => {
    const nonSent: ProposalApplyDelivery['state'][] = [
      'already_sent',
      'blocked',
      'failed',
      'ambiguous',
      'no_channel',
    ];
    for (const state of nonSent) {
      expect(
        toApproveOutcome(delivery({ delivered: false, state, channel: null, recipient: null }))
          .tone,
      ).not.toBe('success');
    }
  });

  it('6) every produced messageKey exists under inbox.delivery in BOTH locales', () => {
    const he = localeKeys('he.json');
    const en = localeKeys('en.json');
    const states: ProposalApplyDelivery['state'][] = [
      'sent',
      'already_sent',
      'blocked',
      'failed',
      'ambiguous',
      'no_channel',
    ];
    const keys = new Set<string>();
    for (const state of states) {
      keys.add(
        toApproveOutcome(
          delivery({
            state,
            channel: state === 'sent' ? 'email' : null,
            recipient: state === 'sent' ? 'na***@x.com' : null,
          }),
        ).messageKey,
      );
      keys.add(
        toApproveOutcome(
          delivery({ state, channel: state === 'sent' ? 'sms' : null, recipient: null }),
        ).messageKey,
      );
    }
    for (const key of keys) {
      expect(he.has(`inbox.delivery.${key}`), `he missing inbox.delivery.${key}`).toBe(true);
      expect(en.has(`inbox.delivery.${key}`), `en missing inbox.delivery.${key}`).toBe(true);
    }
    // The channel labels the inbox interpolates also resolve in both locales.
    for (const ch of ['email', 'sms', 'whatsapp']) {
      expect(he.has(`inbox.delivery.channel.${ch}`)).toBe(true);
      expect(en.has(`inbox.delivery.channel.${ch}`)).toBe(true);
    }
  });
});
