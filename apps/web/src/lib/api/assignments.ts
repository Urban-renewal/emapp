/**
 * Project Assignments API client — Phase 4c S2.
 *
 * Routes:
 *   GET    /api/v1/projects/:projectId/assignments → { data: PA[], page }
 *   POST   /api/v1/projects/:projectId/assignments → { data: PA }     (Manager-only)
 *   DELETE /api/v1/assignments/:id                 → 204               (Manager-only)
 *
 * Note: the unassign DELETE is by ASSIGNMENT id (not userId+projectId).
 * The list response carries the row id; the FE keeps it in the VM
 * (`ProjectAssignmentViewModel.id`) for the unassign call.
 */
import {
  ProjectAssignmentSchema,
  type CreateProjectAssignment,
  type ProjectAssignment,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const AssignmentDataSchema = z.object({ data: ProjectAssignmentSchema });

export interface ProjectAssignmentListPage {
  items: ProjectAssignment[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listProjectAssignments(
  projectId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ProjectAssignmentListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/projects/${projectId}/assignments${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ProjectAssignmentSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function createProjectAssignment(
  projectId: string,
  body: CreateProjectAssignment,
): Promise<ProjectAssignment> {
  // §v9-P0-3 — idempotent so a double-clicked "Assign" creates ONE
  // active row, not two (and the BE's unique-active constraint would
  // catch the second anyway; defense in depth at the wire).
  const res = await apiClient.postIdempotent<unknown>(`/projects/${projectId}/assignments`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return AssignmentDataSchema.parse({ data: res.data }).data;
}

export async function unassignProjectAssignment(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/assignments/${id}`);
  // 204 (empty body) — same pattern as archiveProject / revokeMember.
  if (isOk(res)) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
