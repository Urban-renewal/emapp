/**
 * Apartment API client.
 *
 * v9-post-audit-SOLID-4 — branching uses `isOk()` consistently.
 */
import { ApartmentSchema, type Apartment, type CreateApartment } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const ApartmentDataSchema = z.object({ data: ApartmentSchema });

export interface ApartmentListPage {
  items: Apartment[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listApartments(
  buildingId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ApartmentListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/buildings/${buildingId}/apartments${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ApartmentSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getApartment(id: string): Promise<Apartment> {
  const res = await apiClient.get<unknown>(`/apartments/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentDataSchema.parse({ data: res.data }).data;
}

export async function createApartment(
  buildingId: string,
  body: CreateApartment,
): Promise<Apartment> {
  // §v9-P0-3 — idempotent create POST.
  const res = await apiClient.postIdempotent<unknown>(`/buildings/${buildingId}/apartments`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentDataSchema.parse({ data: res.data }).data;
}

export async function archiveApartment(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/apartments/${id}`);
  if (isOk(res)) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
