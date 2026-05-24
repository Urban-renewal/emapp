import { ApartmentSchema, type Apartment, type CreateApartment } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList } from '../api-client';

import { ApiClientError } from './projects';

const ApartmentDataSchema = z.object({ data: ApartmentSchema });
const ApartmentPageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

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
  const page = ApartmentPageSchema.parse(res.page);
  return { items, page };
}

export async function getApartment(id: string): Promise<Apartment> {
  const res = await apiClient.get<unknown>(`/apartments/${id}`);
  if (!('data' in res)) throw new ApiClientError(res.error);
  return ApartmentDataSchema.parse({ data: res.data }).data;
}

export async function createApartment(
  buildingId: string,
  body: CreateApartment,
): Promise<Apartment> {
  const res = await apiClient.post<unknown>(`/buildings/${buildingId}/apartments`, body);
  if (!('data' in res)) throw new ApiClientError(res.error);
  return ApartmentDataSchema.parse({ data: res.data }).data;
}

export async function archiveApartment(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/apartments/${id}`);
  if ('data' in res) return;
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
