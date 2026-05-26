/**
 * Shares API client — Phase 4f.
 *
 * Routes:
 *   GET    /api/v1/projects/:projectId/shares  → { data, page }
 *   POST   /api/v1/projects/:projectId/shares  → { data: Share }   (Manager)
 *   PATCH  /api/v1/shares/:id                  → { data: Share }   (Manager)
 *   DELETE /api/v1/shares/:id                  → 204                (Manager)
 *
 * `permissions` is .strict()-validated by SharePermissionsSchema —
 * unknown keys are rejected at the BE (and here, defensively). The
 * FE sends the EXACT shape required; no widening / unknown keys.
 */
import {
  CreateShareInput,
  ShareSchema,
  UpdateShareInput,
  type CreateShare,
  type Share,
  type UpdateShare,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const ShareDataSchema = z.object({ data: ShareSchema });

export interface ShareListPage {
  items: Share[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listProjectShares(
  projectId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ShareListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/projects/${projectId}/shares${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ShareSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function createProjectShare(projectId: string, body: CreateShare): Promise<Share> {
  // Defensive client-side Zod parse — any unknown perms key fails
  // here BEFORE the wire (fail-closed; matches BE .strict()).
  const validated = CreateShareInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>(`/projects/${projectId}/shares`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ShareDataSchema.parse({ data: res.data }).data;
}

export async function updateShare(id: string, body: UpdateShare): Promise<Share> {
  const validated = UpdateShareInput.parse(body);
  const res = await apiClient.patch<unknown>(`/shares/${id}`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ShareDataSchema.parse({ data: res.data }).data;
}

export async function revokeShare(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/shares/${id}`);
  if (isOk(res)) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
