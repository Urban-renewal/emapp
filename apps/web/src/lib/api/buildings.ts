/**
 * Building API client — nested under `/projects/:projectId/buildings`
 * for list+create, top-level `/buildings/:id` for view+archive+update
 * (mirrors apps/api/src/modules/buildings/buildings.controller.ts).
 */
import { BuildingSchema, type Building, type CreateBuilding } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList } from '../api-client';

import { ApiClientError } from './projects';

const BuildingDataSchema = z.object({ data: BuildingSchema });
const BuildingPageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export interface BuildingListPage {
  items: Building[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listBuildings(
  projectId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<BuildingListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/projects/${projectId}/buildings${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(BuildingSchema).parse(res.data);
  const page = BuildingPageSchema.parse(res.page);
  return { items, page };
}

export async function getBuilding(id: string): Promise<Building> {
  const res = await apiClient.get<unknown>(`/buildings/${id}`);
  if (!('data' in res)) throw new ApiClientError(res.error);
  return BuildingDataSchema.parse({ data: res.data }).data;
}

export async function createBuilding(projectId: string, body: CreateBuilding): Promise<Building> {
  const res = await apiClient.post<unknown>(`/projects/${projectId}/buildings`, body);
  if (!('data' in res)) throw new ApiClientError(res.error);
  return BuildingDataSchema.parse({ data: res.data }).data;
}

export async function archiveBuilding(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/buildings/${id}`);
  if ('data' in res) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}

export { ApiClientError };
