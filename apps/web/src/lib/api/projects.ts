/**
 * Project API client — wraps the D.16 envelope around the typed
 * shared-types schemas. Defensive `.parse()` on every response per
 * docs/ARCHITECTURE-MAP §1 (the FE doesn't trust the wire).
 *
 * Each function returns either the unwrapped data or throws an
 * `ApiClientError` carrying the D.16 `{ code, message?, details? }`
 * envelope so TanStack Query (or a manual caller) can `error.code`-
 * switch without parsing strings.
 */
import {
  ProjectListItemSchema,
  ProjectSchema,
  type CreateProject,
  type Project,
  type ProjectListItem,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk, type ApiResponse } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

// Write paths (create/archive) still return the bare Project shape.
const ProjectDataSchema = z.object({ data: ProjectSchema });
// list+get carry aggregate stats — must parse against ProjectListItem,
// not ProjectSchema, or Zod strips the stats fields by default and the
// FE renders "—" everywhere even when the API has real numbers.
const ProjectListItemDataSchema = z.object({ data: ProjectListItemSchema });

export interface ProjectListPage {
  items: ProjectListItem[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

// §SOLID-M5 — ApiClientError now lives in `./errors`. This re-export
// keeps the 8 sibling entity files (and tests) working without an
// import sweep; new code should import from `./errors` directly.
export { ApiClientError } from './errors';

function unwrap<T>(res: ApiResponse<T>): T {
  if (isOk(res)) return res.data;
  throw new ApiClientError(res.error);
}

export async function listProjects(query: {
  limit?: number;
  cursor?: string;
}): Promise<ProjectListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/projects${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ProjectListItemSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getProject(id: string): Promise<ProjectListItem> {
  const res = await apiClient.get<unknown>(`/projects/${id}`);
  const data = unwrap(res);
  return ProjectListItemDataSchema.parse({ data }).data;
}

export async function createProject(body: CreateProject): Promise<Project> {
  // §v9-P0-3 — create POSTs carry an Idempotency-Key so a
  // double-clicked Submit creates ONE project, not two.
  const res = await apiClient.postIdempotent<unknown>(`/projects`, body);
  const data = unwrap(res);
  return ProjectDataSchema.parse({ data }).data;
}

export async function archiveProject(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/projects/${id}`);
  // 204 returns an empty body → api-client's invalid-JSON branch wraps
  // it as `{ error: { code: 'invalid_response' } }`. That's expected
  // and harmless for a 204; treat the call as success when the only
  // error is the empty-body code.
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
