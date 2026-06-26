/**
 * Apartment API client.
 *
 * v9-post-audit-SOLID-4 — branching uses `isOk()` consistently.
 */
import {
  ApartmentSchema,
  GenerateApartmentsResultSchema,
  type Apartment,
  type ApartmentStatus,
  type CreateApartment,
  type GenerateApartments,
  type GenerateApartmentsResult,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const ApartmentDataSchema = z.object({ data: ApartmentSchema });
const GenerateResultDataSchema = z.object({ data: GenerateApartmentsResultSchema });

export interface ApartmentListPage {
  items: Apartment[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listApartments(
  buildingId: string,
  query: { limit?: number; cursor?: string; status?: ApartmentStatus } = {},
): Promise<ApartmentListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  // Additive server-side status filter — omitted ⇒ same rows/order as before.
  // Status is an org-scoped enum label (NOT owner PII), so it may ride the URL.
  if (query.status) params.set('status', query.status);
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

/**
 * Slice 2.1 — bulk-GENERATE a building's apartments from its shape in one
 * confirmed action (`POST /buildings/:id/apartments:generate`). The literal
 * `:generate` action-suffix rides the URL as-is. Idempotent create POST (the
 * Idempotency-Key auto-mint replays one response on a network retry — never
 * double-generates). Returns { created, skipped }.
 */
export async function generateApartments(
  buildingId: string,
  body: GenerateApartments,
): Promise<GenerateApartmentsResult> {
  const res = await apiClient.postIdempotent<unknown>(
    `/buildings/${buildingId}/apartments:generate`,
    body,
  );
  if (!isOk(res)) throw new ApiClientError(res.error);
  return GenerateResultDataSchema.parse({ data: res.data }).data;
}

/**
 * Update an apartment's signature-collection status (PATCH /apartments/:id).
 * The BE already exposes this (RequirePermission 'apartments.update') and
 * manages statusChangedAt server-side; the FE simply had no control wired
 * (functionality-without-a-button — QA-APT-STATUS-1). Status-only body keeps
 * the surface minimal; the PATCH DTO accepts a partial.
 */
export async function updateApartmentStatus(
  id: string,
  status: ApartmentStatus,
): Promise<Apartment> {
  const res = await apiClient.patch<unknown>(`/apartments/${id}`, { status });
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ApartmentDataSchema.parse({ data: res.data }).data;
}

export async function archiveApartment(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/apartments/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
