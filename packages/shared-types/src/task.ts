import { z } from 'zod';

// Canonical Task / TaskAssignee contract (Doc 11 SoT; Phase 3 Slice 7).
// Locked-schema aligned (tasks: orgId, projectId?, apartmentId?, title,
// description?, type, status, priority 1-3, dueAt?, durationMinutes?,
// completedAt/By, createdBy, archivedAt). Tasks are ORG-scoped (direct
// RLS). Agent sees ONLY tasks assigned to them (T3.T.1, service-layer).

export const TaskStatusEnum = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  apartmentId: z.string().uuid().nullable(),
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable(),
  type: z.string().min(1).max(50),
  status: TaskStatusEnum,
  priority: z.number().int().min(1).max(3),
  dueAt: z.coerce.date().nullable(),
  durationMinutes: z.number().int().min(0).nullable(),
  // V11 B.S5 F3 fix — migration 0036 (D.38) added scheduled_at +
  // location columns to `tasks` but the read wire never surfaced
  // them. Same F1 class of bug discovered on B.S5 smoke. Distinct
  // from dueAt (soft deadline) — scheduledAt is the calendar EVENT
  // start that drives the WeekCalendar grid + ICS DTSTART.
  scheduledAt: z.coerce.date().nullable(),
  location: z.string().max(500).nullable(),
  completedAt: z.coerce.date().nullable(),
  completedBy: z.string().uuid().nullable(),
  // NULLABLE since wave 1.2 (Autonomous Master Plan): a task AUTO-EXECUTED by the
  // proposal producer has NO human author (`source='system'` + createdBy null). A
  // human-authored task always carries a real uuid.
  createdBy: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

const taskWriteShape = {
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  type: z.string().min(1).max(50).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  durationMinutes: z.number().int().min(0).nullable().optional(),
  // V11 B.S5 F3 — calendar event fields, writable from the AddTask
  // modal (Track A.S12 WeekCalendar consumer). Both optional + nullable
  // — a task can be "scheduled" without a location, or vice-versa.
  scheduledAt: z.coerce.date().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  apartmentId: z.string().uuid().nullable().optional(),
} as const;

/** POST body — title required; assigneeIds optionally seeds task_assignees. */
export const CreateTaskInput = z
  .object({ ...taskWriteShape, assigneeIds: z.array(z.string().uuid()).max(50).optional() })
  .strict();
export type CreateTask = z.infer<typeof CreateTaskInput>;

/** PATCH body — every field optional; status drives completion server-side. */
export const UpdateTaskInput = z
  .object({ ...taskWriteShape, status: TaskStatusEnum.optional() })
  .partial()
  .strict();
export type UpdateTask = z.infer<typeof UpdateTaskInput>;

export const TaskAssigneeSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  userId: z.string().uuid(),
  assignedAt: z.coerce.date(),
});
export type TaskAssignee = z.infer<typeof TaskAssigneeSchema>;

/** POST /tasks/:id/assignees body. */
export const AssignTaskInput = z.object({ userId: z.string().uuid() }).strict();
export type AssignTask = z.infer<typeof AssignTaskInput>;

export const ListTasksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListTasksQueryDto = z.infer<typeof ListTasksQuery>;
