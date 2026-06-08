/**
 * Phase 4f — pin the Wire → ViewModel adapter for Share.
 *
 * Test IDs (D.33):
 *   T-4f-VM.S1   permissions pass through verbatim
 *   T-4f-VM.S2   permissionSummary = "<active> / 3"
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

  it('T-4f-VM.S2) permissionSummary counts ON sections (D.46 default = 2 / 3)', () => {
    // D.46 default: `overview.on` + `signatures.on` (aggregate progress) are
    // the 2 ON sections; documents is OFF. (A3: tenants/notes/team removed as
    // dead — the granted surface is exactly overview/documents/signatures.)
    expect(toShareViewModel(base()).permissionSummary).toBe('2 / 3');
  });

  it('T-D46) the FE default denies documents; mirrors the BE default', () => {
    // Documents manager-selected (OFF), overview + signature progress ON.
    // Keeps the FE form's initial state in sync with the BE
    // `defaultSharePermissions()`.
    expect(SHARE_DEFAULT_PERMISSIONS.documents.on).toBe(false);
    expect(SHARE_DEFAULT_PERMISSIONS.overview.on).toBe(true);
    expect(SHARE_DEFAULT_PERMISSIONS.signatures.on).toBe(true);
  });

  it('T-4f-VM.S2b) countActiveSections — every section on yields 3', () => {
    const allOn: SharePermissions = {
      overview: { on: true },
      documents: { on: true, actions: { download: true } },
      signatures: { on: true },
    };
    expect(countActiveSections(allOn)).toBe(3);
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
