/**
 * Phase 4c S1 — pin the Wire → ViewModel adapter for Member.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S1-VM.1  exhaustive role-label coverage (no enum drift)
 *   T-4c-S1-VM.2  pending state derives correctly (acceptedAt === null)
 *   T-4c-S1-VM.3  active state derives correctly
 *   T-4c-S1-VM.4  revoked state derives correctly (revokedAt wins over accepted)
 *   T-4c-S1-VM.5  state colors are in the locked palette
 *   T-4c-S1-VM.6  HE/EN role labels diverge per locale
 *   T-4c-S1-VM.7  HE/EN state labels diverge per locale
 *   T-4c-S1-VM.8  toMemberViewModels preserves order
 *   T-4c-S1-VM.9  isPrimary passes through verbatim
 *   T-4c-S1-VM.10 VM exposes NO clear-PII keys (defensive — no nationalId/phone)
 */
import { MemberSchema, OrgRoleEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  MEMBER_ROLE_LABELS_EN,
  MEMBER_ROLE_LABELS_HE,
  MEMBER_STATE_COLORS,
  MEMBER_STATE_LABELS_EN,
  MEMBER_STATE_LABELS_HE,
  toMemberViewModel,
  toMemberViewModels,
} from './member';

function baseMember(over: Partial<import('@emapp/shared-types').Member> = {}) {
  return MemberSchema.parse({
    userId: '11111111-1111-1111-1111-111111111111',
    email: 'manager@alpha.dev',
    name: 'דנה כהן',
    role: 'manager',
    isPrimary: false,
    invitedBy: null,
    acceptedAt: new Date('2026-05-20T10:00:00Z'),
    revokedAt: null,
    createdAt: new Date('2026-05-20T10:00:00Z'),
    ...over,
  });
}

describe('toMemberViewModel — D.17 role coverage', () => {
  it('T-4c-S1-VM.1) role labels cover every OrgRoleEnum member (no drift)', () => {
    const enumKeys = [...OrgRoleEnum.options].sort();
    expect(Object.keys(MEMBER_ROLE_LABELS_HE).sort()).toEqual(enumKeys);
    expect(Object.keys(MEMBER_ROLE_LABELS_EN).sort()).toEqual(enumKeys);
  });

  it('T-4c-S1-VM.1b) every role yields a non-empty label in HE + EN', () => {
    for (const role of OrgRoleEnum.options) {
      const vmHe = toMemberViewModel(baseMember({ role }), 'he');
      const vmEn = toMemberViewModel(baseMember({ role }), 'en');
      expect(vmHe.roleLabel.length).toBeGreaterThan(0);
      expect(vmEn.roleLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('toMemberViewModel — D.27 lifecycle state machine', () => {
  it('T-4c-S1-VM.2) pending state — acceptedAt=null + revokedAt=null', () => {
    const vm = toMemberViewModel(baseMember({ acceptedAt: null, revokedAt: null }));
    expect(vm.state).toBe('pending');
    expect(vm.isPending).toBe(true);
    expect(vm.isActive).toBe(false);
    expect(vm.isRevoked).toBe(false);
  });

  it('T-4c-S1-VM.3) active state — acceptedAt set + revokedAt=null', () => {
    const vm = toMemberViewModel(baseMember({ revokedAt: null }));
    expect(vm.state).toBe('active');
    expect(vm.isActive).toBe(true);
  });

  it('T-4c-S1-VM.4) revoked state wins over accepted — revokedAt set, acceptedAt also set', () => {
    const vm = toMemberViewModel(
      baseMember({
        acceptedAt: new Date('2026-05-20T10:00:00Z'),
        revokedAt: new Date('2026-05-22T10:00:00Z'),
      }),
    );
    expect(vm.state).toBe('revoked');
    expect(vm.isRevoked).toBe(true);
    expect(vm.isActive).toBe(false);
  });

  it('T-4c-S1-VM.4b) revoked state — never-accepted invite that was withdrawn', () => {
    const vm = toMemberViewModel(
      baseMember({ acceptedAt: null, revokedAt: new Date('2026-05-22T10:00:00Z') }),
    );
    expect(vm.state).toBe('revoked');
  });

  it('T-4c-S1-VM.5) state intents are confined to the locked semantic set', () => {
    expect(MEMBER_STATE_COLORS.pending).toBe('warning');
    expect(MEMBER_STATE_COLORS.active).toBe('success');
    expect(MEMBER_STATE_COLORS.revoked).toBe('danger');
    const allowed = ['success', 'warning', 'danger', 'info', 'neutral'];
    for (const c of Object.values(MEMBER_STATE_COLORS)) expect(allowed).toContain(c);
  });
});

describe('toMemberViewModel — locale switching', () => {
  it('T-4c-S1-VM.6) HE role labels differ from EN role labels', () => {
    const m = baseMember({ role: 'manager' });
    expect(toMemberViewModel(m, 'he').roleLabel).toBe('מנהל');
    expect(toMemberViewModel(m, 'en').roleLabel).toBe('Manager');
  });

  it('T-4c-S1-VM.7) HE state labels differ from EN state labels', () => {
    const m = baseMember({ acceptedAt: null, revokedAt: null });
    expect(toMemberViewModel(m, 'he').stateLabel).toBe('ממתין לאישור');
    expect(toMemberViewModel(m, 'en').stateLabel).toBe('Pending');
  });

  it('T-4c-S1-VM.7b) HE/EN state label sets cover every state', () => {
    const states = ['pending', 'active', 'revoked'] as const;
    expect(Object.keys(MEMBER_STATE_LABELS_HE).sort()).toEqual([...states].sort());
    expect(Object.keys(MEMBER_STATE_LABELS_EN).sort()).toEqual([...states].sort());
  });
});

describe('toMemberViewModel — field surface', () => {
  it('T-4c-S1-VM.8) toMemberViewModels preserves order', () => {
    const arr = toMemberViewModels([
      baseMember({ userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A' }),
      baseMember({ userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B' }),
    ]);
    expect(arr.map((m) => m.name)).toEqual(['A', 'B']);
  });

  it('T-4c-S1-VM.9) isPrimary passes through verbatim', () => {
    expect(toMemberViewModel(baseMember({ isPrimary: true })).isPrimary).toBe(true);
    expect(toMemberViewModel(baseMember({ isPrimary: false })).isPrimary).toBe(false);
  });

  it('T-4c-S1-VM.10) VM does NOT expose clear-PII keys — defense in depth', () => {
    // Members do not carry PII (no national_id/phone), but if a future
    // contract change adds them, this test makes the VM omission load-
    // bearing. Same pattern as owner.spec.ts:4.
    const vm = toMemberViewModel(baseMember());
    const keys = Object.keys(vm);
    expect(keys).not.toContain('nationalId');
    expect(keys).not.toContain('national_id');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('nationalIdMasked');
  });
});
