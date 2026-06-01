/**
 * Portal adapter — D2 S5 (D.47 masking passthrough + aggregate progress).
 */
import type { TenantPortalMe, TenantPortalProgress } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toPortalMeViewModel, toPortalProgressViewModel } from './portal';

const ME: TenantPortalMe = {
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  name: 'דוד תנעמי',
  email: 'david@example.test',
  // D.47 — already masked at the wire.
  nationalIdMasked: '•••••••89',
  phoneMasked: '•••••4567',
  createdAt: new Date('2026-05-20T10:00:00Z'),
};

function progress(p: Partial<TenantPortalProgress>): TenantPortalProgress {
  return {
    projectId: '33333333-3333-3333-3333-333333333333',
    projectName: 'תמ"א 38',
    status: 'gathering_signatures',
    signaturesSigned: 0,
    signaturesPending: 0,
    signaturesTotal: 0,
    ...p,
  };
}

describe('toPortalMeViewModel — D.47 masked passthrough', () => {
  it('passes the masked national_id + phone through verbatim (no cleartext)', () => {
    const vm = toPortalMeViewModel(ME);
    expect(vm.nationalIdMasked).toBe('•••••••89');
    expect(vm.phoneMasked).toBe('•••••4567');
    // The VM has NO cleartext fields by shape — assert the masked values
    // carry a bullet (i.e. they were not silently replaced by cleartext).
    expect(vm.nationalIdMasked).toMatch(/[•*]/);
    expect(vm.firstName).toBe('דוד');
  });

  it('null phone stays null', () => {
    const vm = toPortalMeViewModel({ ...ME, phoneMasked: null });
    expect(vm.phoneMasked).toBeNull();
  });
});

describe('toPortalProgressViewModel — aggregate %', () => {
  it('computes signedPct = round(signed/total*100)', () => {
    const vm = toPortalProgressViewModel(
      progress({ signaturesSigned: 58, signaturesPending: 42, signaturesTotal: 100 }),
    );
    expect(vm.signedPct).toBe(58);
    expect(vm.signaturesSigned).toBe(58);
    expect(vm.signaturesTotal).toBe(100);
  });

  it('rounds to nearest integer (1 of 3 → 33%)', () => {
    const vm = toPortalProgressViewModel(
      progress({ signaturesSigned: 1, signaturesPending: 2, signaturesTotal: 3 }),
    );
    expect(vm.signedPct).toBe(33);
  });

  it('total 0 → 0% (no divide-by-zero)', () => {
    const vm = toPortalProgressViewModel(progress({ signaturesTotal: 0 }));
    expect(vm.signedPct).toBe(0);
  });

  it('maps status → label + color (he)', () => {
    const vm = toPortalProgressViewModel(progress({ status: 'gathering_signatures' }), 'he');
    expect(vm.statusLabel).toBe('איסוף חתימות');
    expect(vm.statusColor).toBe('amber');
  });
});
