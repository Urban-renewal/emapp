/**
 * §provider-audit adapter — Wire → VM contract pin.
 *
 * Specifically pins the open-set posture of `actionCategory`: a new
 * BE action (e.g. a hypothetical `payment.charge`) MUST NOT crash the
 * FE; the category just becomes `'payment'`. This is critical because
 * the BE adds actions independently of the FE (the action enum is
 * not in shared-types — it's a string at the wire).
 */
import { describe, expect, it } from 'vitest';

import { deriveActionCategory, toProviderAuditItemVM } from './provider-audit';

const SAMPLE_ROW = Object.freeze({
  id: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  actorId: '33333333-3333-3333-3333-333333333333',
  actorType: 'user' as const,
  action: 'import.start',
  targetTable: 'import_jobs',
  targetId: '44444444-4444-4444-4444-444444444444',
  createdAt: new Date('2026-05-25T10:00:00Z'),
});

describe('§provider-audit.deriveActionCategory', () => {
  it('1) common case: "import.start" → "import"', () => {
    expect(deriveActionCategory('import.start')).toBe('import');
  });

  it('2) nested action: "tenant.user.invite" → "tenant"', () => {
    expect(deriveActionCategory('tenant.user.invite')).toBe('tenant');
  });

  it('3) single-segment action: "logout" → "logout"', () => {
    expect(deriveActionCategory('logout')).toBe('logout');
  });

  it('4) empty string → "other" (no crash)', () => {
    expect(deriveActionCategory('')).toBe('other');
  });

  it('5) UPPERCASE first letter is normalised to lowercase', () => {
    expect(deriveActionCategory('Import.start')).toBe('import');
  });

  it('6) garbage that does not match the regex → "other"', () => {
    // Starting char that is NOT a letter — adapter is permissive +
    // returns "other" rather than throwing.
    expect(deriveActionCategory('.start')).toBe('other');
    expect(deriveActionCategory('123.go')).toBe('other');
  });
});

describe('§provider-audit.toProviderAuditItemVM', () => {
  it('7) maps the wire row 1:1 + precomputes actionCategory', () => {
    const vm = toProviderAuditItemVM(SAMPLE_ROW, 'he');
    expect(vm.id).toBe(SAMPLE_ROW.id);
    expect(vm.action).toBe('import.start');
    expect(vm.actionCategory).toBe('import');
    expect(vm.actorType).toBe('user');
    expect(vm.targetTable).toBe('import_jobs');
    expect(vm.createdAtIso).toBe(SAMPLE_ROW.createdAt.toISOString());
    expect(typeof vm.createdRelative).toBe('string');
  });

  it('8) null actorId + null targetTable + null targetId are preserved', () => {
    const vm = toProviderAuditItemVM(
      { ...SAMPLE_ROW, actorId: null, targetTable: null, targetId: null },
      'he',
    );
    expect(vm.actorId).toBeNull();
    expect(vm.targetTable).toBeNull();
    expect(vm.targetId).toBeNull();
  });

  it('9) unknown actor type from a future BE addition would fail Zod parse upstream — this test pins the union', () => {
    // The wire schema enumerates user/system/provider. The VM type
    // declares the same union. If the BE adds a 4th, Zod parse blows
    // up at the api-client layer BEFORE the adapter sees it — so the
    // adapter does NOT need to handle unknown actor types.
    // This test is a documentation pin (no runtime assertion needed
    // beyond the type check at compile time).
    const vm = toProviderAuditItemVM({ ...SAMPLE_ROW, actorType: 'provider' }, 'he');
    expect(vm.actorType).toBe('provider');
  });
});
