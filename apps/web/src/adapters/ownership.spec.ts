/**
 * §SOLID-H1 closure pin — ownership adapter spec.
 *
 * The page used to destructure `current.data.items.map(o => ({ ownerId:
 * o.id, ownershipPct: o.ownershipPct }))` — raw wire shape. Now the
 * hook runs the data through `toOwnershipViewModels` and the page
 * consumes VMs (with `ownerId` already cleanly named, masked PII
 * passed through, role + ownershipPct preserved).
 *
 * This spec pins the adapter so future BE field additions / renames
 * fail CI at the adapter layer rather than silently breaking the page.
 */
import { ApartmentOwnerSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toOwnershipViewModel, toOwnershipViewModels } from './ownership';

function baseApartmentOwner(over: Partial<import('@emapp/shared-types').ApartmentOwner> = {}) {
  return ApartmentOwnerSchema.parse({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    organizationId: '22222222-2222-4222-8222-222222222222',
    name: 'דניאל כהן',
    nationalIdMasked: '•••••••12',
    phoneMasked: '•••••3456',
    email: null,
    notes: null,
    archivedAt: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    ownershipId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    ownershipPct: 50,
    relationship: 'owner',
    role: 'spouse',
    ...over,
  });
}

describe('toOwnershipViewModel — §SOLID-H1', () => {
  it('1) renames id → ownerId and preserves ownershipId', () => {
    const vm = toOwnershipViewModel(baseApartmentOwner());
    expect(vm.ownerId).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(vm.ownershipId).toBe('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb');
  });

  it('2) surfaces masked PII pass-through (no clear values)', () => {
    const vm = toOwnershipViewModel(baseApartmentOwner());
    expect(vm.nationalIdMasked).toBe('•••••••12');
    expect(vm.phoneMasked).toBe('•••••3456');
  });

  it('3) VM has NO clear PII keys (key-allowlist defense in depth)', () => {
    const vm = toOwnershipViewModel(baseApartmentOwner());
    const keys = Object.keys(vm).sort();
    expect(keys).toEqual([
      'displayName',
      'nationalIdMasked',
      'ownerId',
      'ownershipId',
      'ownershipPct',
      'phoneMasked',
      'role',
    ]);
    // explicitly: no `nationalId`, no `phone`, no `national_id`, no `email`, no `notes`
    expect(vm).not.toHaveProperty('nationalId');
    expect(vm).not.toHaveProperty('phone');
    expect(vm).not.toHaveProperty('national_id');
    expect(vm).not.toHaveProperty('email');
    expect(vm).not.toHaveProperty('notes');
  });

  it('4) ownershipPct + role preserved verbatim', () => {
    expect(toOwnershipViewModel(baseApartmentOwner({ ownershipPct: 33.33 })).ownershipPct).toBe(
      33.33,
    );
    expect(toOwnershipViewModel(baseApartmentOwner({ role: null })).role).toBeNull();
    expect(toOwnershipViewModel(baseApartmentOwner({ role: 'co-owner' })).role).toBe('co-owner');
  });

  it('5) phoneMasked nullable', () => {
    expect(toOwnershipViewModel(baseApartmentOwner({ phoneMasked: null })).phoneMasked).toBeNull();
  });

  it('6) toOwnershipViewModels preserves order', () => {
    const arr = toOwnershipViewModels([
      baseApartmentOwner({ ownershipId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb' }),
      baseApartmentOwner({ ownershipId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' }),
    ]);
    expect(arr.map((v) => v.ownershipId)).toEqual([
      'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
      'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    ]);
  });
});
