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
import type { ProposalView } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toProposalViewModel, toProposalViewModels } from './proposal';

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
