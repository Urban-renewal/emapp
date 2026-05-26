/**
 * Phase 4f — pin the Wire → ViewModel adapter for Share.
 *
 * Test IDs (D.33):
 *   T-4f-VM.S1   permissions pass through verbatim
 *   T-4f-VM.S2   permissionSummary = "<active> / 6"
 *   T-4f-VM.S3   contractorIdShort = first 8 hex
 *   T-4f-VM.S4   contractorName resolved via lookup
 *   T-4f-VM.S5   contractorName undefined when lookup absent
 *   T-4f-VM.S6   isRevoked toggle by revokedAt
 */
import { ShareSchema, type SharePermissions } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { SHARE_DEFAULT_PERMISSIONS, countActiveSections } from '@/models/share.vm';

import { toShareViewModel } from './share';

function base(over: Partial<import('@emapp/shared-types').Share> = {}) {
  return ShareSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    contractorId: 'abcdef12-3456-4789-8abc-def012345678',
    permissions: SHARE_DEFAULT_PERMISSIONS,
    revokedAt: null,
    lastAccessedAt: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    ...over,
  });
}

describe('toShareViewModel', () => {
  it('T-4f-VM.S1) permissions object passes through verbatim', () => {
    const vm = toShareViewModel(base());
    expect(vm.permissions).toEqual(SHARE_DEFAULT_PERMISSIONS);
  });

  it('T-4f-VM.S2) permissionSummary counts ON sections (default = 1 / 6)', () => {
    // SHARE_DEFAULT_PERMISSIONS has only `overview.on: true` of the 6 top-level sections.
    expect(toShareViewModel(base()).permissionSummary).toBe('1 / 6');
  });

  it('T-4f-VM.S2b) countActiveSections — every section on yields 6', () => {
    const allOn: SharePermissions = {
      overview: { on: true },
      tenants: {
        on: true,
        fields: { name: true, phone: true, email: true, national_id: true, note: true },
      },
      documents: { on: true, actions: { download: true, upload: true } },
      signatures: { on: true },
      notes: { on: true },
      team: { on: true },
    };
    expect(countActiveSections(allOn)).toBe(6);
  });

  it('T-4f-VM.S3) contractorIdShort = first 8 hex chars (no dashes)', () => {
    expect(toShareViewModel(base()).contractorIdShort).toBe('abcdef12');
  });

  it('T-4f-VM.S4) contractorName resolves via lookup', () => {
    const lookup = new Map([['abcdef12-3456-4789-8abc-def012345678', 'Acme Construction']]);
    expect(toShareViewModel(base(), 'he', lookup).contractorName).toBe('Acme Construction');
  });

  it('T-4f-VM.S5) contractorName undefined when no lookup', () => {
    expect(toShareViewModel(base()).contractorName).toBeUndefined();
  });

  it('T-4f-VM.S6) isRevoked toggle', () => {
    expect(toShareViewModel(base({ revokedAt: new Date() })).isRevoked).toBe(true);
    expect(toShareViewModel(base({ revokedAt: null })).isRevoked).toBe(false);
  });
});
