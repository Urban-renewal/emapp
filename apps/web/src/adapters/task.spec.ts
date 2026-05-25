/**
 * Phase 4d — pin the Wire → ViewModel adapter for Task.
 *
 * Test IDs (D.33 mapping):
 *   T-4d-VM.1   status labels exhaustive over TaskStatusEnum (no drift)
 *   T-4d-VM.2   status colors in the locked palette
 *   T-4d-VM.3   priority labels 1/2/3 → low/normal/high (HE + EN)
 *   T-4d-VM.4   isTerminal — completed/cancelled true; pending/in_progress false
 *   T-4d-VM.5   isOverdue — dueAt past + non-terminal → true
 *   T-4d-VM.6   isOverdue — dueAt past + terminal → false (terminal wins)
 *   T-4d-VM.7   isOverdue — dueAt future → false
 *   T-4d-VM.8   isArchived toggle
 *   T-4d-VM.9   null due/completed pass through verbatim
 *   T-4d-VM.10  assignee userIdShort + lookup degrade
 */
import { TaskAssigneeSchema, TaskSchema, TaskStatusEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  TASK_PRIORITY_LABELS_EN,
  TASK_PRIORITY_LABELS_HE,
  TASK_STATUS_COLORS,
  TASK_STATUS_LABELS_EN,
  TASK_STATUS_LABELS_HE,
  toTaskAssigneeViewModel,
  toTaskViewModel,
} from './task';

const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');
const FAR_PAST = new Date('2000-01-01T00:00:00Z');

function baseTask(over: Partial<import('@emapp/shared-types').Task> = {}) {
  return TaskSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    projectId: null,
    apartmentId: null,
    title: 'Sample',
    description: null,
    type: 'general',
    status: 'pending',
    priority: 2,
    dueAt: null,
    durationMinutes: null,
    completedAt: null,
    completedBy: null,
    createdBy: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:00Z'),
    archivedAt: null,
    ...over,
  });
}

describe('toTaskViewModel — status enum coverage', () => {
  it('T-4d-VM.1) HE + EN labels cover every TaskStatusEnum member', () => {
    const enumKeys = [...TaskStatusEnum.options].sort();
    expect(Object.keys(TASK_STATUS_LABELS_HE).sort()).toEqual(enumKeys);
    expect(Object.keys(TASK_STATUS_LABELS_EN).sort()).toEqual(enumKeys);
  });

  it('T-4d-VM.2) status colors are confined to the locked palette', () => {
    const allowed = ['gray', 'amber', 'emerald', 'red'];
    for (const c of Object.values(TASK_STATUS_COLORS)) expect(allowed).toContain(c);
  });

  it('T-4d-VM.2b) every status renders a non-empty label in HE + EN', () => {
    for (const s of TaskStatusEnum.options) {
      expect(toTaskViewModel(baseTask({ status: s }), 'he').statusLabel.length).toBeGreaterThan(0);
      expect(toTaskViewModel(baseTask({ status: s }), 'en').statusLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('toTaskViewModel — priority', () => {
  it('T-4d-VM.3) HE labels: 1=נמוכה, 2=רגילה, 3=דחופה', () => {
    expect(TASK_PRIORITY_LABELS_HE[1]).toBe('נמוכה');
    expect(TASK_PRIORITY_LABELS_HE[2]).toBe('רגילה');
    expect(TASK_PRIORITY_LABELS_HE[3]).toBe('דחופה');
  });

  it('T-4d-VM.3b) EN labels: 1/2/3 → Low/Normal/High', () => {
    expect(TASK_PRIORITY_LABELS_EN[1]).toBe('Low');
    expect(TASK_PRIORITY_LABELS_EN[2]).toBe('Normal');
    expect(TASK_PRIORITY_LABELS_EN[3]).toBe('High');
  });

  it('T-4d-VM.3c) priority badge: only 3 → red, 1/2 → gray', () => {
    expect(toTaskViewModel(baseTask({ priority: 1 })).priorityBadge).toBe('gray');
    expect(toTaskViewModel(baseTask({ priority: 2 })).priorityBadge).toBe('gray');
    expect(toTaskViewModel(baseTask({ priority: 3 })).priorityBadge).toBe('red');
  });
});

describe('toTaskViewModel — terminal + overdue + archived', () => {
  it('T-4d-VM.4) isTerminal — completed/cancelled true; others false', () => {
    expect(toTaskViewModel(baseTask({ status: 'completed' })).isTerminal).toBe(true);
    expect(toTaskViewModel(baseTask({ status: 'cancelled' })).isTerminal).toBe(true);
    expect(toTaskViewModel(baseTask({ status: 'pending' })).isTerminal).toBe(false);
    expect(toTaskViewModel(baseTask({ status: 'in_progress' })).isTerminal).toBe(false);
  });

  it('T-4d-VM.5) isOverdue — dueAt past + status non-terminal → true', () => {
    expect(toTaskViewModel(baseTask({ dueAt: FAR_PAST, status: 'pending' })).isOverdue).toBe(true);
    expect(toTaskViewModel(baseTask({ dueAt: FAR_PAST, status: 'in_progress' })).isOverdue).toBe(
      true,
    );
  });

  it('T-4d-VM.6) isOverdue — terminal wins over past-due (completed/cancelled never overdue)', () => {
    expect(toTaskViewModel(baseTask({ dueAt: FAR_PAST, status: 'completed' })).isOverdue).toBe(
      false,
    );
    expect(toTaskViewModel(baseTask({ dueAt: FAR_PAST, status: 'cancelled' })).isOverdue).toBe(
      false,
    );
  });

  it('T-4d-VM.7) isOverdue — dueAt future → false (regardless of status)', () => {
    expect(toTaskViewModel(baseTask({ dueAt: FAR_FUTURE })).isOverdue).toBe(false);
  });

  it('T-4d-VM.7b) isOverdue — no dueAt → false', () => {
    expect(toTaskViewModel(baseTask({ dueAt: null })).isOverdue).toBe(false);
  });

  it('T-4d-VM.8) isArchived toggle by archivedAt', () => {
    expect(toTaskViewModel(baseTask({ archivedAt: new Date() })).isArchived).toBe(true);
    expect(toTaskViewModel(baseTask({ archivedAt: null })).isArchived).toBe(false);
  });
});

describe('toTaskViewModel — null surface', () => {
  it('T-4d-VM.9) null due/completed → null on VM (not "")', () => {
    const vm = toTaskViewModel(baseTask({ dueAt: null, completedAt: null }));
    expect(vm.dueAtIso).toBe(null);
    expect(vm.dueRelative).toBe(null);
    expect(vm.completedAtIso).toBe(null);
    expect(vm.completedRelative).toBe(null);
  });

  it('T-4d-VM.9b) description null passes through', () => {
    expect(toTaskViewModel(baseTask({ description: null })).description).toBe(null);
  });
});

describe('toTaskAssigneeViewModel — lookup degrade', () => {
  const SAMPLE_ASSIGNEE = TaskAssigneeSchema.parse({
    id: '44444444-4444-4444-8444-444444444444',
    taskId: '11111111-1111-4111-8111-111111111111',
    userId: 'abcdef12-3456-4789-8abc-def012345678',
    assignedAt: new Date('2026-05-21T10:00:00Z'),
  });

  it('T-4d-VM.10) without lookup → name/email undefined; userIdShort = first 8 hex', () => {
    const vm = toTaskAssigneeViewModel(SAMPLE_ASSIGNEE);
    expect(vm.name).toBeUndefined();
    expect(vm.email).toBeUndefined();
    expect(vm.userIdShort).toBe('abcdef12');
  });

  it('T-4d-VM.10b) with lookup → name/email populated', () => {
    const lookup = new Map([
      [SAMPLE_ASSIGNEE.userId, { name: 'Dana Cohen', email: 'dana@alpha.dev' }],
    ]);
    const vm = toTaskAssigneeViewModel(SAMPLE_ASSIGNEE, 'he', lookup);
    expect(vm.name).toBe('Dana Cohen');
    expect(vm.email).toBe('dana@alpha.dev');
  });
});
