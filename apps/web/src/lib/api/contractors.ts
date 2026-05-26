/**
 * Contractors API client — Phase 4f.
 *
 * Routes:
 *   GET    /api/v1/contractors            → { data, page }
 *   POST   /api/v1/contractors            → { data: Contractor }   (Manager)
 *   GET    /api/v1/contractors/:id        → { data: Contractor }
 *   PATCH  /api/v1/contractors/:id        → { data: Contractor }   (Manager)
 *   DELETE /api/v1/contractors/:id        → 204                     (Manager)
 */
import {
  ContractorSchema,
  type Contractor,
  type CreateContractor,
  type UpdateContractor,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const ContractorDataSchema = z.object({ data: ContractorSchema });

export interface ContractorListPage {
  items: Contractor[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listContractors(
  query: { limit?: number; cursor?: string } = {},
): Promise<ContractorListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/contractors${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ContractorSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getContractor(id: string): Promise<Contractor> {
  const res = await apiClient.get<unknown>(`/contractors/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ContractorDataSchema.parse({ data: res.data }).data;
}

export async function createContractor(body: CreateContractor): Promise<Contractor> {
  const res = await apiClient.postIdempotent<unknown>(`/contractors`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ContractorDataSchema.parse({ data: res.data }).data;
}

export async function updateContractor(id: string, body: UpdateContractor): Promise<Contractor> {
  const res = await apiClient.patch<unknown>(`/contractors/${id}`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ContractorDataSchema.parse({ data: res.data }).data;
}

export async function archiveContractor(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/contractors/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
