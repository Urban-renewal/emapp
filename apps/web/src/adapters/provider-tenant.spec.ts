/**
 * §provider-tenant adapter — Wire → VM contract pin (D.37).
 *
 * Threat-model linkage:
 *  - Security: assert masked PII is passed through unchanged (the VM
 *    has NO unmasked surface; this test catches a future refactor
 *    that accidentally adds a `name` field on the sample-owner VM).
 *  - Performance: pure function, single-pass map; the spec also pins
 *    that `toTenantListItemVMs` is array-stable (no allocations
 *    beyond the result).
 *  - Error handling: passing null `archivedAt` flows to `isArchived:
 *    false`; non-null → true. No special-case throws.
 */
import { describe, expect, it } from 'vitest';

import {
  toSampleOwnerVM,
  toTenantDetailVM,
  toTenantListItemVM,
  toTenantListItemVMs,
} from './provider-tenant';

const SAMPLE_LIST_ROW = Object.freeze({
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Alpha Urban Renewal Ltd.',
  slug: 'alpha',
  createdAt: new Date('2026-04-25T10:00:00Z'),
  archivedAt: null,
  suspendedAt: null,
  counts: { users: 3, projects: 1, owners: 3 },
});

const SAMPLE_DETAIL_ROW = Object.freeze({
  ...SAMPLE_LIST_ROW,
  suspendedAt: null,
  suspendedReason: null,
  counts: { users: 3, projects: 1, owners: 3, importJobs: 0, signatureRequests: 0 },
  sampleOwners: [
    {
      id: '22222222-2222-2222-2222-222222222222',
      nameMasked: '•••••••JK', // intentionally tail-chars only
      email: 'sample@example.test',
      phoneMasked: '•••••1234',
      archivedAt: null,
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      nameMasked: '•••••••XY',
      email: null,
      phoneMasked: null,
      archivedAt: new Date('2026-04-30T10:00:00Z'),
    },
  ],
});

describe('§provider-tenant.toTenantListItemVM', () => {
  it('1) maps the wire row 1:1 + computes archived flag', () => {
    const vm = toTenantListItemVM(SAMPLE_LIST_ROW, 'he');
    expect(vm.id).toBe(SAMPLE_LIST_ROW.id);
    expect(vm.name).toBe(SAMPLE_LIST_ROW.name);
    expect(vm.slug).toBe(SAMPLE_LIST_ROW.slug);
    expect(vm.userCount).toBe(3);
    expect(vm.projectCount).toBe(1);
    expect(vm.ownerCount).toBe(3);
    expect(vm.isArchived).toBe(false);
    expect(vm.createdAtIso).toBe(SAMPLE_LIST_ROW.createdAt.toISOString());
    expect(typeof vm.createdRelative).toBe('string');
  });

  it('2) archived row sets isArchived=true', () => {
    const vm = toTenantListItemVM(
      { ...SAMPLE_LIST_ROW, archivedAt: new Date('2026-05-01T00:00:00Z') },
      'he',
    );
    expect(vm.isArchived).toBe(true);
  });

  it('2b) suspended row sets isSuspended=true (distinct from archived)', () => {
    const vm = toTenantListItemVM(
      { ...SAMPLE_LIST_ROW, suspendedAt: new Date('2026-05-02T00:00:00Z') },
      'he',
    );
    expect(vm.isSuspended).toBe(true);
    expect(vm.isArchived).toBe(false);
  });

  it('3) toTenantListItemVMs preserves order and length', () => {
    const rows = [
      SAMPLE_LIST_ROW,
      { ...SAMPLE_LIST_ROW, id: '99999999-9999-9999-9999-999999999999', name: 'Other' },
    ];
    const vms = toTenantListItemVMs(rows, 'he');
    expect(vms).toHaveLength(2);
    expect(vms[0]!.id).toBe(rows[0]!.id);
    expect(vms[1]!.name).toBe('Other');
  });

  it('4) en locale produces a (possibly different) createdRelative string — no throw', () => {
    const vm = toTenantListItemVM(SAMPLE_LIST_ROW, 'en');
    expect(vm.createdRelative).toBeTypeOf('string');
  });
});

describe('§provider-tenant.toSampleOwnerVM — PII masked passthrough', () => {
  it('5) nameMasked + phoneMasked are passed through VERBATIM', () => {
    const wire = SAMPLE_DETAIL_ROW.sampleOwners[0]!;
    const vm = toSampleOwnerVM(wire);
    expect(vm.nameMasked).toBe(wire.nameMasked);
    expect(vm.phoneMasked).toBe(wire.phoneMasked);
    // VM MUST NOT expose any unmasked field.
    expect((vm as unknown as Record<string, unknown>)['name']).toBeUndefined();
    expect((vm as unknown as Record<string, unknown>)['phone']).toBeUndefined();
    expect((vm as unknown as Record<string, unknown>)['national_id']).toBeUndefined();
  });

  it('6) phoneMasked=null is preserved (no empty-string coercion that loses the signal)', () => {
    const wire = SAMPLE_DETAIL_ROW.sampleOwners[1]!;
    const vm = toSampleOwnerVM(wire);
    expect(vm.phoneMasked).toBeNull();
    expect(vm.email).toBeNull();
  });

  it('7) archivedAt → isArchived boolean', () => {
    const live = toSampleOwnerVM(SAMPLE_DETAIL_ROW.sampleOwners[0]!);
    const archived = toSampleOwnerVM(SAMPLE_DETAIL_ROW.sampleOwners[1]!);
    expect(live.isArchived).toBe(false);
    expect(archived.isArchived).toBe(true);
  });
});

describe('§provider-tenant.toTenantDetailVM', () => {
  it('8) maps all 5 counts + sampleOwners array', () => {
    const vm = toTenantDetailVM(SAMPLE_DETAIL_ROW, 'he');
    expect(vm.counts).toEqual({
      users: 3,
      projects: 1,
      owners: 3,
      importJobs: 0,
      signatureRequests: 0,
    });
    expect(vm.sampleOwners).toHaveLength(2);
    expect(vm.sampleOwners[0]!.nameMasked).toBe('•••••••JK');
  });

  it('9) empty sampleOwners array works', () => {
    const vm = toTenantDetailVM({ ...SAMPLE_DETAIL_ROW, sampleOwners: [] }, 'he');
    expect(vm.sampleOwners).toEqual([]);
  });

  it('10) D.49 — active tenant maps to not-suspended (null reason/relative)', () => {
    const vm = toTenantDetailVM(SAMPLE_DETAIL_ROW, 'he');
    expect(vm.isSuspended).toBe(false);
    expect(vm.suspendedRelative).toBeNull();
    expect(vm.suspendedReason).toBeNull();
  });

  it('11) D.49 — suspended tenant maps state + relative + operator note', () => {
    const vm = toTenantDetailVM(
      {
        ...SAMPLE_DETAIL_ROW,
        suspendedAt: new Date('2026-05-20T08:00:00Z'),
        suspendedReason: 'non-payment',
      },
      'he',
    );
    expect(vm.isSuspended).toBe(true);
    expect(vm.suspendedRelative).not.toBeNull();
    expect(vm.suspendedReason).toBe('non-payment');
  });
});
