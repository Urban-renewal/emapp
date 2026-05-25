/**
 * Ownerships API client.
 *
 * D.25 — composition is ATOMIC per apartment. The locked Phase-1
 * constraint trigger (`trg_ownerships_sum_check`, DEFERRABLE) requires
 * SUM(ownership_pct) over an apartment's ACTIVE rows to be 0 or
 * exactly 100 at COMMIT. The only coherent write is full-set REPLACE.
 *
 * The FE-side sum-100 validation in shared-types' `SetOwnershipsInput`
 * is the FIRST line of defense; the server's Zod refine + the trigger
 * are the second and third. All three must align — the trigger raise
 * is mapped server-side to `ownership_sum_invalid` (400).
 *
 * §v9-H-5 closure — `putOwnerships` uses `apiClient.put` so the 401 →
 * silent refresh → replay path, the 15s timeout, the envelope guard,
 * and the `emapp:unauthenticated` event all apply uniformly. No raw
 * fetch bypass.
 */
import {
  ApartmentOwnerSchema,
  SetOwnershipsInput,
  type ApartmentOwner,
  type SetOwnerships,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const ApartmentOwnersListSchema = z.array(ApartmentOwnerSchema);

export interface ApartmentOwnersPage {
  items: ApartmentOwner[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listApartmentOwners(
  apartmentId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ApartmentOwnersPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(
    `/apartments/${apartmentId}/owners${qs ? `?${qs}` : ''}`,
  );
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = ApartmentOwnersListSchema.parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

/**
 * PUT /apartments/:apartmentId/ownerships — atomic full-set replace
 * (D.25). Uses `apiClient.put` so 401/refresh/timeout/envelope-guard
 * all run uniformly (§v9-H-5).
 */
export async function putOwnerships(apartmentId: string, body: SetOwnerships): Promise<void> {
  // FE-side defensive parse — never PUT a malformed body. A failed
  // parse throws ZodError to the caller (NOT an ApiClientError).
  SetOwnershipsInput.parse(body);
  const res = await apiClient.put<unknown>(`/apartments/${apartmentId}/ownerships`, body);
  if (isOk(res)) return;
  // 204 No Content / empty body folds to invalid_response by the
  // api-client envelope guard; treat that as success.
  if (res.error.code === 'invalid_response') return;
  throw new ApiClientError(res.error);
}
