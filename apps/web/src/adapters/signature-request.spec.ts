/**
 * Phase 4a S9 — pin the Wire → ViewModel adapter for SignatureRequest
 * (D.12 LAW). Adversarial coverage (per Doc 11 + the "try to break it"
 * mandate):
 *
 *  - HE / EN labels EXHAUSTIVELY cover the 3-state enum.
 *  - CANCELLABLE excludes terminal states AND excludes expired-pending
 *    rows (no point cancelling a token the server has already killed
 *    via the atomic guard).
 *  - isExpired only flips for `pending` past `expiresAt` — a `signed`
 *    row past expiry is still `signed` (the row is forensic, not live).
 *  - signedRelative / cancelledRelative null when timestamps null.
 *  - Locale switching produces distinct strings.
 */
import { SignatureRequestSchema, SignatureRequestStatusEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  SIGNATURE_REQUEST_CANCELLABLE_STATES,
  SIGNATURE_REQUEST_STATUS_INTENTS,
  SIGNATURE_REQUEST_STATUS_LABELS_EN,
  SIGNATURE_REQUEST_STATUS_LABELS_HE,
  SIGNATURE_REQUEST_TERMINAL_STATES,
  toSignatureRequestViewModel,
  toSignatureRequestViewModels,
} from './signature-request';

function baseReq(over: Partial<import('@emapp/shared-types').SignatureRequest> = {}) {
  return SignatureRequestSchema.parse({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    organizationId: '22222222-2222-4222-8222-222222222222',
    documentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ownerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    status: 'pending',
    expiresAt: new Date('2026-06-01T10:00:00Z'),
    createdBy: '11111111-1111-4111-8111-111111111111',
    createdAt: new Date('2026-05-25T10:00:00Z'),
    signedAt: null,
    signedSignatureId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...over,
  });
}

describe('toSignatureRequestViewModel — D.12 3-state machine', () => {
  it('1) HE labels cover every SignatureRequestStatusEnum option', () => {
    const k = Object.keys(SIGNATURE_REQUEST_STATUS_LABELS_HE).sort();
    expect(k).toEqual([...SignatureRequestStatusEnum.options].sort());
  });

  it('2) EN labels cover every SignatureRequestStatusEnum option', () => {
    const k = Object.keys(SIGNATURE_REQUEST_STATUS_LABELS_EN).sort();
    expect(k).toEqual([...SignatureRequestStatusEnum.options].sort());
  });

  it('3) STATUS_INTENTS covers every option', () => {
    const k = Object.keys(SIGNATURE_REQUEST_STATUS_INTENTS).sort();
    expect(k).toEqual([...SignatureRequestStatusEnum.options].sort());
  });

  it('4) TERMINAL set is exactly {signed, cancelled}', () => {
    expect([...SIGNATURE_REQUEST_TERMINAL_STATES].sort()).toEqual(['cancelled', 'signed']);
  });

  it('5) CANCELLABLE is exactly {pending} (cannot cancel terminal states)', () => {
    expect([...SIGNATURE_REQUEST_CANCELLABLE_STATES]).toEqual(['pending']);
  });

  it('6) isCancellable=true only for pending AND not expired', () => {
    const now = new Date('2026-05-26T00:00:00Z');
    const vmFresh = toSignatureRequestViewModel(
      baseReq({ status: 'pending', expiresAt: new Date('2026-06-01T00:00:00Z') }),
      'he',
      now,
    );
    expect(vmFresh.isCancellable).toBe(true);
    expect(vmFresh.isExpired).toBe(false);
  });

  it('7) isCancellable=false for pending past expiresAt (server already killed token)', () => {
    const now = new Date('2026-06-10T00:00:00Z');
    const vmExpired = toSignatureRequestViewModel(
      baseReq({ status: 'pending', expiresAt: new Date('2026-06-01T00:00:00Z') }),
      'he',
      now,
    );
    expect(vmExpired.isExpired).toBe(true);
    expect(vmExpired.isCancellable).toBe(false);
  });

  it('8) isCancellable=false for signed (BE returns 409 signature_request_already_signed)', () => {
    expect(
      toSignatureRequestViewModel(baseReq({ status: 'signed', signedAt: new Date() }))
        .isCancellable,
    ).toBe(false);
  });

  it('9) isCancellable=false for cancelled (idempotent on BE but UI hides the action)', () => {
    expect(
      toSignatureRequestViewModel(baseReq({ status: 'cancelled', cancelledAt: new Date() }))
        .isCancellable,
    ).toBe(false);
  });

  it('10) isTerminal mirrors TERMINAL_STATES exactly', () => {
    expect(toSignatureRequestViewModel(baseReq({ status: 'pending' })).isTerminal).toBe(false);
    expect(
      toSignatureRequestViewModel(baseReq({ status: 'signed', signedAt: new Date() })).isTerminal,
    ).toBe(true);
    expect(
      toSignatureRequestViewModel(baseReq({ status: 'cancelled', cancelledAt: new Date() }))
        .isTerminal,
    ).toBe(true);
  });

  it('11) isExpired does NOT flip for signed-past-expiry (row is forensic, not live)', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const vm = toSignatureRequestViewModel(
      baseReq({
        status: 'signed',
        expiresAt: new Date('2026-06-01T00:00:00Z'),
        signedAt: new Date('2026-05-30T00:00:00Z'),
      }),
      'he',
      now,
    );
    expect(vm.isExpired).toBe(false);
  });

  it('12) signedRelative / cancelledRelative null when timestamps null', () => {
    const vm = toSignatureRequestViewModel(baseReq({ status: 'pending' }));
    expect(vm.signedRelative).toBeNull();
    expect(vm.cancelledRelative).toBeNull();
  });

  it('13) HE/EN labels are distinct (locale switching works)', () => {
    expect(toSignatureRequestViewModel(baseReq(), 'he').statusLabel).toBe('ממתין לחתימה');
    expect(toSignatureRequestViewModel(baseReq(), 'en').statusLabel).toBe('Pending');
  });

  it('14) expiresAtIso is a proper ISO-8601 string', () => {
    const vm = toSignatureRequestViewModel(
      baseReq({ expiresAt: new Date('2026-06-01T10:00:00Z') }),
    );
    expect(vm.expiresAtIso).toBe('2026-06-01T10:00:00.000Z');
  });

  it('15) toSignatureRequestViewModels preserves order', () => {
    const arr = toSignatureRequestViewModels([
      baseReq({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' }),
      baseReq({ id: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa' }),
    ]);
    expect(arr.map((v) => v.id)).toEqual([
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
    ]);
  });
});
