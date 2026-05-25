/**
 * Phase 4c S2 — pin the Wire → ViewModel adapter for ProjectAssignment.
 *
 * Test IDs (D.33 mapping):
 *   T-4c-S2-VM.1  active state — unassignedAt=null
 *   T-4c-S2-VM.2  inactive state — unassignedAt set
 *   T-4c-S2-VM.3  userIdShort = 8-char hex prefix (no dashes)
 *   T-4c-S2-VM.4  member-lookup enrichment populates name+email
 *   T-4c-S2-VM.5  missing lookup → name/email undefined (graceful degrade)
 *   T-4c-S2-VM.6  toProjectAssignmentViewModels preserves order
 *   T-4c-S2-VM.7  assignedAtIso is the canonical ISO form
 */
import { ProjectAssignmentSchema } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { toProjectAssignmentViewModel, toProjectAssignmentViewModels } from './project-assignment';

function baseAssignment(over: Partial<import('@emapp/shared-types').ProjectAssignment> = {}) {
  return ProjectAssignmentSchema.parse({
    id: '11111111-1111-1111-1111-111111111111',
    projectId: '22222222-2222-2222-2222-222222222222',
    userId: '33333333-aaaa-bbbb-cccc-444444444444',
    roleInProject: 'agent',
    assignedAt: new Date('2026-05-20T10:00:00Z'),
    unassignedAt: null,
    ...over,
  });
}

describe('toProjectAssignmentViewModel — lifecycle', () => {
  it('T-4c-S2-VM.1) unassignedAt=null → active=true', () => {
    expect(toProjectAssignmentViewModel(baseAssignment()).active).toBe(true);
  });

  it('T-4c-S2-VM.2) unassignedAt set → active=false', () => {
    expect(
      toProjectAssignmentViewModel(
        baseAssignment({ unassignedAt: new Date('2026-05-22T10:00:00Z') }),
      ).active,
    ).toBe(false);
  });
});

describe('toProjectAssignmentViewModel — id rendering', () => {
  it('T-4c-S2-VM.3) userIdShort is the first 8 hex chars (no dashes)', () => {
    const vm = toProjectAssignmentViewModel(baseAssignment());
    expect(vm.userIdShort).toBe('33333333');
    expect(vm.userIdShort.length).toBe(8);
    expect(vm.userIdShort).not.toContain('-');
  });

  it('T-4c-S2-VM.3b) userId passes through verbatim (full UUID still on the VM for actions)', () => {
    const vm = toProjectAssignmentViewModel(baseAssignment());
    expect(vm.userId).toBe('33333333-aaaa-bbbb-cccc-444444444444');
  });
});

describe('toProjectAssignmentViewModel — member-lookup enrichment', () => {
  it('T-4c-S2-VM.4) lookup map populates name + email when the userId matches', () => {
    const lookup = new Map([
      ['33333333-aaaa-bbbb-cccc-444444444444', { name: 'Dana Cohen', email: 'dana@alpha.dev' }],
    ]);
    const vm = toProjectAssignmentViewModel(baseAssignment(), 'he', lookup);
    expect(vm.name).toBe('Dana Cohen');
    expect(vm.email).toBe('dana@alpha.dev');
  });

  it('T-4c-S2-VM.5) missing lookup → name + email undefined (Agent/Viewer degrade)', () => {
    const vm = toProjectAssignmentViewModel(baseAssignment(), 'he', undefined);
    expect(vm.name).toBeUndefined();
    expect(vm.email).toBeUndefined();
  });

  it('T-4c-S2-VM.5b) lookup map with NO matching userId → name + email undefined', () => {
    const lookup = new Map([
      ['99999999-9999-4999-8999-999999999999', { name: 'Wrong User', email: 'wrong@x.dev' }],
    ]);
    const vm = toProjectAssignmentViewModel(baseAssignment(), 'he', lookup);
    expect(vm.name).toBeUndefined();
    expect(vm.email).toBeUndefined();
  });
});

describe('toProjectAssignmentViewModel — surface', () => {
  it('T-4c-S2-VM.6) toProjectAssignmentViewModels preserves order', () => {
    const arr = toProjectAssignmentViewModels([
      baseAssignment({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      baseAssignment({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ]);
    expect(arr.map((a) => a.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('T-4c-S2-VM.7) assignedAtIso is the canonical ISO form', () => {
    const vm = toProjectAssignmentViewModel(baseAssignment());
    expect(vm.assignedAtIso).toBe('2026-05-20T10:00:00.000Z');
  });

  it('T-4c-S2-VM.7b) assignedRelative is a non-empty string', () => {
    const vm = toProjectAssignmentViewModel(baseAssignment());
    expect(typeof vm.assignedRelative).toBe('string');
    expect(vm.assignedRelative.length).toBeGreaterThan(0);
  });
});
