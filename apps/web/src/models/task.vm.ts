/**
 * Task ViewModel — Phase 4d.
 *
 * Tasks are ORG-scoped. D.17 role visibility:
 *   - manager  : all org tasks + full CRUD
 *   - viewer   : all org tasks + read-only
 *   - agent    : ONLY tasks they're assigned to (BE service-layer JOIN);
 *                may update only `status` + `description` on own tasks
 *
 * Status enum (locked, TaskStatusEnum):
 *   pending | in_progress | completed | cancelled
 *
 * Priority (locked 1..3): 1=low / 2=normal / 3=high.
 *
 * The VM derives:
 *  - `statusLabel` / `intent` — HE/EN exhaustive over enum
 *  - `priorityLabel` / `priorityBadge` — 1..3 → low/normal/high
 *  - `isOverdue`     — dueAt < now AND status NOT terminal
 *  - `isTerminal`    — status ∈ {completed, cancelled}
 *  - `isArchived`    — archivedAt set (BE excludes archived from list,
 *                      but the detail page can still reach a row that
 *                      was archived between fetches)
 */
import type { TaskStatus } from '@emapp/shared-types';

export type TaskPriorityLevel = 1 | 2 | 3;

export interface TaskViewModel {
  id: string;
  organizationId: string;
  projectId: string | null;
  apartmentId: string | null;
  title: string;
  description: string | null;
  type: string;
  status: TaskStatus;
  statusLabel: string;
  intent: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  priority: TaskPriorityLevel;
  priorityLabel: string;
  priorityBadge: 'neutral' | 'warning' | 'danger';
  dueAtIso: string | null;
  dueRelative: string | null;
  durationMinutes: number | null;
  completedAtIso: string | null;
  completedRelative: string | null;
  completedBy: string | null;
  // Nullable since wave 1.2: a SYSTEM-AUTHORED task (auto-executed by the autonomy
  // engine) has no human author.
  createdBy: string | null;
  createdAtIso: string;
  createdRelative: string;
  isOverdue: boolean;
  isTerminal: boolean;
  isArchived: boolean;
}

export interface TaskAssigneeViewModel {
  id: string;
  taskId: string;
  userId: string;
  /** 8-char hex prefix (same pattern as ProjectAssignmentViewModel). */
  userIdShort: string;
  /** Resolved from /members cache when caller is Manager; undefined
   *  for Agent/Viewer (their /members fetch 403s). */
  name?: string;
  email?: string;
  assignedAtIso: string;
  assignedRelative: string;
}
