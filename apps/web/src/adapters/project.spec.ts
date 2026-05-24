/**
 * Phase 4a S2 — pin the Wire → ViewModel adapter for Project.
 *
 * The adapter encodes D.18 (status enum LAW) into Hebrew labels +
 * color buckets. Drift between the wire enum and the label table
 * would silently mis-render a Manager's dashboard — these tests
 * fail fast if the enum is extended without the adapter.
 *
 * Approach (per docs/05 §9.8 + the user's "make it fall" testing
 * mandate): exhaustive over the locked enum sets — every status ×
 * type combination yields a non-empty Hebrew label + a known color.
 * `Object.keys` of the labels record is also checked against the
 * Zod enum to catch enum extensions that forget to update labels.
 */
import { ProjectSchema, ProjectStatusEnum, ProjectTypeEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  PROJECT_STATUS_COLORS,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  toProjectViewModel,
  toProjectViewModels,
} from './project';

function baseProject(over: Partial<import('@emapp/shared-types').Project> = {}) {
  return ProjectSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'Test',
    type: 'tama38_2',
    status: 'planning',
    description: null,
    targetSignaturePct: null,
    startedAt: null,
    createdBy: '33333333-3333-3333-3333-333333333333',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toProjectViewModel — D.18 enum coverage', () => {
  it('1) labels cover every status enum member (no drift)', () => {
    const labelKeys = Object.keys(PROJECT_STATUS_LABELS).sort();
    const enumKeys = [...ProjectStatusEnum.options].sort();
    expect(labelKeys).toEqual(enumKeys);
  });

  it('2) colors cover every status enum member', () => {
    const colorKeys = Object.keys(PROJECT_STATUS_COLORS).sort();
    const enumKeys = [...ProjectStatusEnum.options].sort();
    expect(colorKeys).toEqual(enumKeys);
  });

  it('3) type labels cover every type enum member', () => {
    const typeKeys = Object.keys(PROJECT_TYPE_LABELS).sort();
    const enumKeys = [...ProjectTypeEnum.options].sort();
    expect(typeKeys).toEqual(enumKeys);
  });

  it('4) every (status × type) combination yields a non-empty Hebrew label + valid color', () => {
    for (const status of ProjectStatusEnum.options) {
      for (const type of ProjectTypeEnum.options) {
        const vm = toProjectViewModel(baseProject({ status, type }));
        expect(vm.statusLabel.length).toBeGreaterThan(0);
        expect(vm.typeLabel.length).toBeGreaterThan(0);
        expect(['gray', 'amber', 'emerald', 'red']).toContain(vm.statusColor);
      }
    }
  });
});

describe('toProjectViewModel — field surface', () => {
  it('5) name, type, status pass through verbatim; id/createdAtIso preserved', () => {
    const vm = toProjectViewModel(
      baseProject({ name: 'Bar', type: 'pinui_binui', status: 'approved' }),
    );
    expect(vm.name).toBe('Bar');
    expect(vm.type).toBe('pinui_binui');
    expect(vm.status).toBe('approved');
    expect(vm.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(vm.createdAtIso).toBe('2026-05-20T10:00:00.000Z');
  });

  it('6) archivedAt=null → isArchived=false', () => {
    const vm = toProjectViewModel(baseProject({ archivedAt: null }));
    expect(vm.isArchived).toBe(false);
  });

  it('7) archivedAt=Date → isArchived=true', () => {
    const vm = toProjectViewModel(baseProject({ archivedAt: new Date('2026-05-22T00:00:00Z') }));
    expect(vm.isArchived).toBe(true);
  });

  it('8) description null becomes null; description "X" passes through', () => {
    expect(toProjectViewModel(baseProject({ description: null })).description).toBe(null);
    expect(toProjectViewModel(baseProject({ description: 'X' })).description).toBe('X');
  });

  it('9) createdRelative returns a non-empty string (relative or ISO fallback)', () => {
    const vm = toProjectViewModel(baseProject());
    expect(typeof vm.createdRelative).toBe('string');
    expect(vm.createdRelative.length).toBeGreaterThan(0);
  });

  it('10) toProjectViewModels preserves order and length', () => {
    const arr = toProjectViewModels([
      baseProject({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A' }),
      baseProject({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B' }),
    ]);
    expect(arr.map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('locked Hebrew labels (regression guards)', () => {
  it('11) status label values match D.18 Hebrew set', () => {
    expect(PROJECT_STATUS_LABELS.planning).toBe('בתכנון');
    expect(PROJECT_STATUS_LABELS.gathering_signatures).toBe('איסוף חתימות');
    expect(PROJECT_STATUS_LABELS.approved).toBe('מאושר');
    expect(PROJECT_STATUS_LABELS.in_construction).toBe('בבנייה');
    expect(PROJECT_STATUS_LABELS.completed).toBe('הושלם');
    expect(PROJECT_STATUS_LABELS.cancelled).toBe('בוטל');
  });

  it('12) type label values include both tama38 variants + pinui-binui', () => {
    expect(PROJECT_TYPE_LABELS.tama38_1).toContain('38');
    expect(PROJECT_TYPE_LABELS.tama38_2).toContain('38');
    expect(PROJECT_TYPE_LABELS.pinui_binui).toContain('פינוי');
  });
});
