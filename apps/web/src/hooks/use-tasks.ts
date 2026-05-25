'use client';

import type { AssignTask, CreateTask, UpdateTask } from '@emapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import { toTaskAssigneeViewModels, toTaskViewModel, toTaskViewModels } from '@/adapters/task';
import {
  addTaskAssignee,
  archiveTask,
  createTask,
  getTask,
  listTaskAssignees,
  listTasks,
  removeTaskAssignee,
  updateTask,
  type TaskListPage,
} from '@/lib/api/tasks';
import { useDisplayLocale } from '@/lib/locale';
import type { TaskAssigneeViewModel, TaskViewModel } from '@/models/task.vm';

/**
 * Tasks data hooks. Same shape as use-members / use-projects:
 *   - per-query staleTime 30s
 *   - memoised `select` via useCallback (PERF-H3)
 *
 * The Agent's role-based filter happens server-side; the FE doesn't
 * branch on `user.role` here — `listTasks` returns whatever the BE
 * decides the caller can see.
 */

const TASKS_KEY = ['tasks'] as const;

export function useTaskList(query: { limit?: number; cursor?: string } = {}) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: TaskListPage) => ({
      items: toTaskViewModels(data.items, locale),
      page: data.page,
    }),
    [locale],
  );
  return useQuery<TaskListPage, Error, { items: TaskViewModel[]; page: TaskListPage['page'] }>({
    queryKey: [...TASKS_KEY, 'list', query, locale],
    queryFn: () => listTasks(query),
    staleTime: 30_000,
    select,
  });
}

export function useTask(id: string | undefined) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: import('@emapp/shared-types').Task) => toTaskViewModel(data, locale),
    [locale],
  );
  return useQuery({
    queryKey: [...TASKS_KEY, 'one', id, locale],
    queryFn: () => {
      if (!id) throw new Error('useTask requires an id');
      return getTask(id);
    },
    enabled: Boolean(id),
    staleTime: 30_000,
    select,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTask) => createTask(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: UpdateTask }) => updateTask(input.id, input.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });
}

export function useArchiveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => archiveTask(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });
}

/** Lists assignees + optionally JOINs with a member lookup (Manager
 *  has /members access; Agent/Viewer get raw userIds). */
export function useTaskAssignees(
  taskId: string | undefined,
  userIdToMember?: Map<string, AssignmentMemberLookup>,
) {
  const locale = useDisplayLocale();
  const select = useCallback(
    (data: import('@emapp/shared-types').TaskAssignee[]) =>
      toTaskAssigneeViewModels(data, locale, userIdToMember),
    [locale, userIdToMember],
  );
  return useQuery<import('@emapp/shared-types').TaskAssignee[], Error, TaskAssigneeViewModel[]>({
    queryKey: [...TASKS_KEY, 'assignees', taskId, locale],
    queryFn: () => {
      if (!taskId) throw new Error('useTaskAssignees requires a taskId');
      return listTaskAssignees(taskId);
    },
    enabled: Boolean(taskId),
    staleTime: 30_000,
    select,
  });
}

export function useAddTaskAssignee(taskId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AssignTask) => {
      if (!taskId) throw new Error('useAddTaskAssignee requires a taskId');
      return addTaskAssignee(taskId, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...TASKS_KEY, 'assignees', taskId] });
    },
  });
}

export function useRemoveTaskAssignee(taskId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => {
      if (!taskId) throw new Error('useRemoveTaskAssignee requires a taskId');
      return removeTaskAssignee(taskId, userId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...TASKS_KEY, 'assignees', taskId] });
    },
  });
}
