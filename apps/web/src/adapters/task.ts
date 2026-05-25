/**
 * Wire → ViewModel adapter for Task / TaskAssignee (Phase 4d).
 * Pure functions; docs/05 §9.8 pattern.
 *
 * Status + priority labels owned HERE (HE/EN) — they map a LOCKED enum
 * (TaskStatusEnum + 1..3 priority) to product-specific HE terminology
 * and a 4-color status palette. The exhaustive `Object.keys(LABELS) ===
 * EnumOptions` test catches enum drift on the BE without an explicit
 * update here.
 */

import type { Task, TaskAssignee, TaskStatus } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { TaskAssigneeViewModel, TaskPriorityLevel, TaskViewModel } from '@/models/task.vm';

import type { AssignmentMemberLookup } from './project-assignment';

const STATUS_LABELS_HE: Record<TaskStatus, string> = {
  pending: 'ממתין',
  in_progress: 'בביצוע',
  completed: 'הושלם',
  cancelled: 'בוטל',
};

const STATUS_LABELS_EN: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<TaskStatus, TaskViewModel['statusColor']> = {
  pending: 'gray',
  in_progress: 'amber',
  completed: 'emerald',
  cancelled: 'red',
};

const PRIORITY_LABELS_HE: Record<TaskPriorityLevel, string> = {
  1: 'נמוכה',
  2: 'רגילה',
  3: 'דחופה',
};

const PRIORITY_LABELS_EN: Record<TaskPriorityLevel, string> = {
  1: 'Low',
  2: 'Normal',
  3: 'High',
};

const PRIORITY_BADGES: Record<TaskPriorityLevel, TaskViewModel['priorityBadge']> = {
  1: 'gray',
  2: 'gray',
  3: 'red',
};

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'cancelled']);

export function toTaskViewModel(t: Task, locale: DisplayLocale = 'he'): TaskViewModel {
  const statusLabels = locale === 'en' ? STATUS_LABELS_EN : STATUS_LABELS_HE;
  const priorityLabels = locale === 'en' ? PRIORITY_LABELS_EN : PRIORITY_LABELS_HE;
  const priority = (t.priority as TaskPriorityLevel) ?? 2;
  const isTerminal = TERMINAL_STATUSES.has(t.status);
  const now = Date.now();
  const dueMs = t.dueAt ? t.dueAt.getTime() : null;
  const isOverdue = !isTerminal && dueMs !== null && dueMs < now;
  return {
    id: t.id,
    organizationId: t.organizationId,
    projectId: t.projectId,
    apartmentId: t.apartmentId,
    title: t.title,
    description: t.description,
    type: t.type,
    status: t.status,
    statusLabel: statusLabels[t.status],
    statusColor: STATUS_COLORS[t.status],
    priority,
    priorityLabel: priorityLabels[priority],
    priorityBadge: PRIORITY_BADGES[priority],
    dueAtIso: t.dueAt ? t.dueAt.toISOString() : null,
    dueRelative: t.dueAt ? formatRelative(t.dueAt, locale) : null,
    durationMinutes: t.durationMinutes,
    completedAtIso: t.completedAt ? t.completedAt.toISOString() : null,
    completedRelative: t.completedAt ? formatRelative(t.completedAt, locale) : null,
    completedBy: t.completedBy,
    createdBy: t.createdBy,
    createdAtIso: t.createdAt.toISOString(),
    createdRelative: formatRelative(t.createdAt, locale),
    isOverdue,
    isTerminal,
    isArchived: t.archivedAt !== null,
  };
}

export function toTaskViewModels(items: Task[], locale: DisplayLocale = 'he'): TaskViewModel[] {
  return items.map((t) => toTaskViewModel(t, locale));
}

export function toTaskAssigneeViewModel(
  a: TaskAssignee,
  locale: DisplayLocale = 'he',
  userIdToMember?: Map<string, AssignmentMemberLookup>,
): TaskAssigneeViewModel {
  const found = userIdToMember?.get(a.userId);
  return {
    id: a.id,
    taskId: a.taskId,
    userId: a.userId,
    userIdShort: a.userId.replace(/-/g, '').slice(0, 8),
    name: found?.name,
    email: found?.email,
    assignedAtIso: a.assignedAt.toISOString(),
    assignedRelative: formatRelative(a.assignedAt, locale),
  };
}

export function toTaskAssigneeViewModels(
  items: TaskAssignee[],
  locale: DisplayLocale = 'he',
  userIdToMember?: Map<string, AssignmentMemberLookup>,
): TaskAssigneeViewModel[] {
  return items.map((a) => toTaskAssigneeViewModel(a, locale, userIdToMember));
}

export const TASK_STATUS_LABELS_HE = STATUS_LABELS_HE;
export const TASK_STATUS_LABELS_EN = STATUS_LABELS_EN;
export const TASK_STATUS_COLORS = STATUS_COLORS;
export const TASK_PRIORITY_LABELS_HE = PRIORITY_LABELS_HE;
export const TASK_PRIORITY_LABELS_EN = PRIORITY_LABELS_EN;
export const TASK_PRIORITY_BADGES = PRIORITY_BADGES;
