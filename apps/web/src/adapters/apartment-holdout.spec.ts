/**
 * E2 Wave-2 E2.2-S3 / B4 — apartment HOLDOUT adapter (Wire → ViewModel).
 *
 * The holdout NAME is real owner PII (user/Excel authored), so unlike the rest
 * of the project adapter it MUST be bidi-stripped (a U+202E RLO embedded in a
 * name could spoof neighboring UI — §v9-H-3). These tests pin:
 *   - the name is bidi-stripped,
 *   - a null / blank name normalises to null (so the component renders the
 *     anonymous "owner without a name" label, never an empty <bdi>),
 *   - national_id / phone never leak through (B4 invariant — the wire shape
 *     carries name only, but the adapter must not invent them either).
 */
import { ApartmentHoldoutSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toApartmentHoldoutViewModel, toApartmentHoldoutViewModels } from './project';

const RLO = String.fromCharCode(0x202e); // right-to-left override — the bidi-spoof codepoint

function holdout(over: Partial<import('@emapp/shared-types').ApartmentHoldout> = {}) {
  return ApartmentHoldoutSchema.parse({
    ownerId: '11111111-1111-1111-1111-111111111111',
    name: 'ישראל ישראלי',
    apartmentNumber: '7',
    ...over,
  });
}

describe('toApartmentHoldoutViewModel — B4 holdout PII adapter', () => {
  it('1) passes through ownerId + apartmentNumber and keeps the name', () => {
    const vm = toApartmentHoldoutViewModel(holdout());
    expect(vm.ownerId).toBe('11111111-1111-1111-1111-111111111111');
    expect(vm.apartmentNumber).toBe('7');
    expect(vm.name).toBe('ישראל ישראלי');
  });

  it('2) bidi-strips a name carrying an embedded RTL override (spoof defense)', () => {
    const vm = toApartmentHoldoutViewModel(holdout({ name: `דנה${RLO}כהן` }));
    expect(vm.name).not.toContain(RLO);
    expect(vm.name).toBe('דנהכהן');
  });

  it('3) normalises a null name to null (anonymous shell owner)', () => {
    const vm = toApartmentHoldoutViewModel(holdout({ name: null }));
    expect(vm.name).toBeNull();
  });

  it('4) normalises a blank/whitespace name to null', () => {
    const vm = toApartmentHoldoutViewModel(holdout({ name: '   ' }));
    expect(vm.name).toBeNull();
  });

  it('5) never surfaces national_id / phone (B4 — name only)', () => {
    const vm = toApartmentHoldoutViewModel(holdout());
    expect(vm).not.toHaveProperty('national_id');
    expect(vm).not.toHaveProperty('nationalId');
    expect(vm).not.toHaveProperty('phone');
    expect(Object.keys(vm).sort()).toEqual(['apartmentNumber', 'name', 'ownerId']);
  });

  it('6) maps a list', () => {
    const vms = toApartmentHoldoutViewModels([
      holdout(),
      holdout({ ownerId: '22222222-2222-2222-2222-222222222222', name: 'משה לוי' }),
    ]);
    expect(vms).toHaveLength(2);
    expect(vms[1]!.name).toBe('משה לוי');
  });
});
