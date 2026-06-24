/**
 * X-S6/X-S7 — pin the external-share adapter (FE ceiling mirror + Wire→VM).
 *
 * Test IDs:
 *   X-VM.S1  toViewModel — permissionSummary "active / 3", scopeCount, isRevoked
 *   X-VM.S2  countdown seed — msUntilExpiry sign + isExpired toggle around `now`
 *   X-VM.S3  no-expiry — msUntilExpiry null, isExpired false
 *   X-CEIL.S1 FE ceiling mirror is internally COHERENT (download ⊆ documents.on)
 *   X-CEIL.S2 presetDefault NEVER exceeds its party ceiling (FE cannot widen) — G-RT
 *   X-CEIL.S3 presetDefault FORCES sensitive off + bounds TTL to the ceiling — #486
 */
import { ExternalShareSchema, type ExternalSharePartyType } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SHARE_PARTY_TYPES,
  FE_PARTY_CEILINGS,
  ceilingAllowsSensitive,
  presetDefaultFor,
  toExternalShareViewModel,
} from './external-share';

function share(over: Partial<import('@emapp/shared-types').ExternalShareView> = {}) {
  return ExternalShareSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    partyType: 'appraiser',
    scopeType: 'apartment',
    scopeIds: ['33333333-3333-4333-8333-333333333333'],
    permissions: {
      overview: { on: true },
      documents: { on: true, actions: { download: false } },
      signatures: { on: false },
    },
    allowSensitive: false,
    otpRequired: true,
    expiresAt: '2026-07-20T10:00:00.000Z',
    watermarkSubject: null,
    revokedAt: null,
    createdAt: '2026-06-20T10:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
    ...over,
  });
}

describe('external-share adapter — Wire → VM', () => {
  it('X-VM.S1) summary + scopeCount + isRevoked', () => {
    const vm = toExternalShareViewModel(share(), 'he', new Date('2026-06-21T10:00:00Z'));
    // overview + documents on, signatures off → 2 / 3
    expect(vm.permissionSummary).toBe('2 / 3');
    expect(vm.scopeCount).toBe(1);
    expect(vm.isRevoked).toBe(false);
    expect(toExternalShareViewModel(share({ revokedAt: new Date() })).isRevoked).toBe(true);
  });

  it('X-VM.S2) countdown seed sign + isExpired around now', () => {
    const before = toExternalShareViewModel(share(), 'he', new Date('2026-07-19T10:00:00Z'));
    expect(before.msUntilExpiry).toBeGreaterThan(0);
    expect(before.isExpired).toBe(false);
    const after = toExternalShareViewModel(share(), 'he', new Date('2026-07-21T10:00:00Z'));
    expect(after.msUntilExpiry).toBeLessThan(0);
    expect(after.isExpired).toBe(true);
  });

  it('X-VM.S3) no expiry → null countdown, never expired', () => {
    const vm = toExternalShareViewModel(share({ expiresAt: null }));
    expect(vm.msUntilExpiry).toBeNull();
    expect(vm.isExpired).toBe(false);
    expect(vm.expiresAtIso).toBeNull();
  });
});

describe('external-share adapter — FE ceiling mirror (G-RT: cannot widen)', () => {
  it('X-CEIL.S1) every ceiling is internally coherent (download ⊆ documents.on)', () => {
    for (const pt of EXTERNAL_SHARE_PARTY_TYPES) {
      const c = FE_PARTY_CEILINGS[pt];
      if (c.permissions.documents.actions.download) {
        expect(c.permissions.documents.on).toBe(true);
      }
    }
  });

  it('X-CEIL.S2) presetDefault NEVER exceeds its party ceiling', () => {
    for (const pt of EXTERNAL_SHARE_PARTY_TYPES) {
      const c = FE_PARTY_CEILINGS[pt];
      const preset = presetDefaultFor(pt);
      const p = preset.permissions;
      // Every preset flag must be ≤ the ceiling flag (cannot turn ON what the
      // ceiling forbids — this is the FE-side narrows-only guarantee).
      if (p.overview.on) expect(c.permissions.overview.on).toBe(true);
      if (p.documents.on) expect(c.permissions.documents.on).toBe(true);
      if (p.documents.actions.download) expect(c.permissions.documents.actions.download).toBe(true);
      if (p.signatures.on) expect(c.permissions.signatures.on).toBe(true);
      // scope_type rank must be ≤ the ceiling (preset uses the ceiling's max).
      expect(preset.scopeType).toBe(c.maxScopeType);
    }
  });

  it('X-CEIL.S3) presetDefault bounds TTL to ceiling + sensitive helper matches', () => {
    for (const pt of EXTERNAL_SHARE_PARTY_TYPES) {
      const c = FE_PARTY_CEILINGS[pt];
      const preset = presetDefaultFor(pt);
      if (c.maxTtlDays !== null) {
        expect(preset.ttlDays).toBeLessThanOrEqual(c.maxTtlDays);
      }
      expect(ceilingAllowsSensitive(pt)).toBe(c.allowSensitive);
    }
  });

  it('X-CEIL.S4) the FE mirror covers EVERY party-type enum value (no gap)', () => {
    const enumValues: ExternalSharePartyType[] = [
      'developer',
      'developer_lawyer',
      'tenant_lawyer',
      'bank',
      'supervisor',
      'appraiser',
      'surveyor',
      'committee',
      'special_admin',
    ];
    for (const pt of enumValues) {
      expect(FE_PARTY_CEILINGS[pt]).toBeDefined();
      expect(EXTERNAL_SHARE_PARTY_TYPES).toContain(pt);
    }
    expect(EXTERNAL_SHARE_PARTY_TYPES).toHaveLength(enumValues.length);
  });
});
