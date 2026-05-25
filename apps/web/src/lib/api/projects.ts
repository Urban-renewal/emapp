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
import { ProjectSchema, type CreateProject, type Project } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk, type ApiResponse } from '../api-client';

import { ApiClientError } from './errors';

const ProjectDataSchema = z.object({ data: ProjectSchema });
const ProjectPageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export interface ProjectListPage {
  items: Project[];
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
  const items = z.array(ProjectSchema).parse(res.data);
  const page = ProjectPageSchema.parse(res.page);
  return { items, page };
}

export async function getProject(id: string): Promise<Project> {
  const res = await apiClient.get<unknown>(`/projects/${id}`);
  const data = unwrap(res);
  return ProjectDataSchema.parse({ data }).data;
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
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
