/**
 * Phase 4f — pin the Wire → ViewModel adapter for Contractor.
 *
 * Test IDs (D.33):
 *   T-4f-VM.C1   field pass-through (name, contactEmail)
 *   T-4f-VM.C2   nullable fields (contactPhone/companyId/specialty/notes) pass null
 *   T-4f-VM.C3   isArchived toggle
 */
import { ContractorSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toContractorViewModel, toContractorViewModels } from './contractor';

function base(over: Partial<import('@emapp/shared-types').Contractor> = {}) {
  return ContractorSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    name: 'אבני בניין בע"מ',
    contactEmail: 'info@avnei.dev',
    contactPhone: null,
    companyId: null,
    specialty: null,
    notes: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toContractorViewModel', () => {
  it('T-4f-VM.C1) name + contactEmail pass through verbatim', () => {
    const vm = toContractorViewModel(base({ name: 'X', contactEmail: 'a@b.dev' }));
    expect(vm.name).toBe('X');
    expect(vm.contactEmail).toBe('a@b.dev');
  });

  it('T-4f-VM.C2) nullable fields pass null verbatim', () => {
    const vm = toContractorViewModel(base());
    expect(vm.contactPhone).toBe(null);
    expect(vm.companyId).toBe(null);
    expect(vm.specialty).toBe(null);
    expect(vm.notes).toBe(null);
  });

  it('T-4f-VM.C3) isArchived toggle', () => {
    expect(toContractorViewModel(base({ archivedAt: new Date() })).isArchived).toBe(true);
    expect(toContractorViewModel(base({ archivedAt: null })).isArchived).toBe(false);
  });

  it('T-4f-VM.C4) toContractorViewModels preserves order', () => {
    const arr = toContractorViewModels([
      base({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'A' }),
      base({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'B' }),
    ]);
    expect(arr.map((c) => c.name)).toEqual(['A', 'B']);
  });
});
