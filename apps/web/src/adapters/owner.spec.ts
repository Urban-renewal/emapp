/**
 * Phase 4a S5 — pin the Wire → ViewModel adapter for Owner.
 *
 * The hard rule under test: the ViewModel passes through the
 * server-side MASKED PII fields verbatim and does NOT manufacture
 * clear values. If a future server change accidentally widened the
 * wire to include clear `nationalId`, the FE adapter would still
 * only render the masked fields — this test pins that.
 */
import { OwnerSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toOwnerViewModel, toOwnerViewModels } from './owner';

function baseOwner(over: Partial<import('@emapp/shared-types').Owner> = {}) {
  return OwnerSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'דנה כהן',
    email: null,
    nationalIdMasked: '•••••••11',
    phoneMasked: null,
    notes: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toOwnerViewModel — PII discipline', () => {
  it('1) nationalIdMasked passes through verbatim', () => {
    const vm = toOwnerViewModel(baseOwner({ nationalIdMasked: '•••••••82' }));
    expect(vm.nationalIdMasked).toBe('•••••••82');
  });

  it('2) phoneMasked null when no phone on file', () => {
    expect(toOwnerViewModel(baseOwner({ phoneMasked: null })).phoneMasked).toBe(null);
  });

  it('3) phoneMasked passes through verbatim when present', () => {
    expect(toOwnerViewModel(baseOwner({ phoneMasked: '•••••4567' })).phoneMasked).toBe('•••••4567');
  });

  it('4) VM exposes ONLY the masked PII keys, not clear `nationalId` / `phone`', () => {
    const vm = toOwnerViewModel(baseOwner());
    expect(Object.keys(vm)).toContain('nationalIdMasked');
    expect(Object.keys(vm)).toContain('phoneMasked');
    expect(Object.keys(vm)).not.toContain('nationalId');
    expect(Object.keys(vm)).not.toContain('phone');
    expect(Object.keys(vm)).not.toContain('national_id');
  });

  it('5) name + email + notes pass through; null → null', () => {
    const vm = toOwnerViewModel(baseOwner({ email: 'x@y.dev', notes: 'note', name: 'שרה' }));
    expect(vm.name).toBe('שרה');
    expect(vm.email).toBe('x@y.dev');
    expect(vm.notes).toBe('note');
    expect(toOwnerViewModel(baseOwner()).email).toBe(null);
    expect(toOwnerViewModel(baseOwner()).notes).toBe(null);
  });

  it('6) isArchived toggle by archivedAt', () => {
    expect(
      toOwnerViewModel(baseOwner({ archivedAt: new Date('2026-05-22T00:00:00Z') })).isArchived,
    ).toBe(true);
    expect(toOwnerViewModel(baseOwner({ archivedAt: null })).isArchived).toBe(false);
  });

  it('7) toOwnerViewModels preserves order', () => {
    const arr = toOwnerViewModels([
      baseOwner({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A' }),
      baseOwner({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B' }),
    ]);
    expect(arr.map((o) => o.name)).toEqual(['A', 'B']);
  });
});
