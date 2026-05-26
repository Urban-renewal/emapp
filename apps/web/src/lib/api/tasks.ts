/**
 * Tasks API client — Phase 4d.
 *
 * Routes (org-scoped; D.17):
 *   GET    /api/v1/tasks                                 → { data, page }
 *   POST   /api/v1/tasks                                 → { data: Task }   (Manager)
 *   GET    /api/v1/tasks/:id                             → { data: Task }
 *   PATCH  /api/v1/tasks/:id                             → { data: Task }   (Manager/Agent — restricted)
 *   DELETE /api/v1/tasks/:id                             → 204               (Manager)
 *   GET    /api/v1/tasks/:id/assignees                   → { data: Assignee[] }
 *   POST   /api/v1/tasks/:id/assignees                   → { data: Assignee } (Manager)
 *   DELETE /api/v1/tasks/:id/assignees/:userId           → 204               (Manager)
 *
 * Agent role visibility (BE service-layer): list + get return ONLY rows
 * the Agent is currently assigned to. update is constrained to
 * status + description on those rows. The FE doesn't replicate the
 * filter — it just consumes what the BE returns.
 *
 * Defensive Zod parse on every response (per docs/ARCHITECTURE-MAP §1).
 */
import {
  AssignTaskInput,
  TaskAssigneeSchema,
  TaskSchema,
  type AssignTask,
  type CreateTask,
  type Task,
  type TaskAssignee,
  type UpdateTask,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const TaskDataSchema = z.object({ data: TaskSchema });
const TaskAssigneeDataSchema = z.object({ data: TaskAssigneeSchema });
const TaskAssigneesDataSchema = z.object({ data: z.array(TaskAssigneeSchema) });

export interface TaskListPage {
  items: Task[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listTasks(
  query: { limit?: number; cursor?: string } = {},
): Promise<TaskListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/tasks${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(TaskSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getTask(id: string): Promise<Task> {
  const res = await apiClient.get<unknown>(`/tasks/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TaskDataSchema.parse({ data: res.data }).data;
}

export async function createTask(body: CreateTask): Promise<Task> {
  // §v9-P0-3 — idempotent create POST.
  const res = await apiClient.postIdempotent<unknown>(`/tasks`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TaskDataSchema.parse({ data: res.data }).data;
}

export async function updateTask(id: string, body: UpdateTask): Promise<Task> {
  const res = await apiClient.patch<unknown>(`/tasks/${id}`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TaskDataSchema.parse({ data: res.data }).data;
}

export async function archiveTask(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/tasks/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}

export async function listTaskAssignees(taskId: string): Promise<TaskAssignee[]> {
  const res = await apiClient.get<unknown>(`/tasks/${taskId}/assignees`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TaskAssigneesDataSchema.parse({ data: res.data }).data;
}

export async function addTaskAssignee(taskId: string, body: AssignTask): Promise<TaskAssignee> {
  // Defensive client-side parse so a malformed body never reaches the
  // wire — same posture as acceptInvite + ownerships set-replace.
  const validated = AssignTaskInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/tasks/${taskId}/assignees`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return TaskAssigneeDataSchema.parse({ data: res.data }).data;
}

export async function removeTaskAssignee(taskId: string, userId: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/tasks/${taskId}/assignees/${userId}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
