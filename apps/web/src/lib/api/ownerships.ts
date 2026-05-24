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
 */
import {
  ApartmentOwnerSchema,
  SetOwnershipsInput,
  type ApartmentOwner,
  type SetOwnerships,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList } from '../api-client';

import { ApiClientError } from './projects';

const ApartmentOwnersListSchema = z.array(ApartmentOwnerSchema);
const PageSchema = z.object({
  limit: z.number().int().positive(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
});

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
 * (D.25). api-client doesn't expose a PUT helper today (one-off
 * method); we make the raw same-origin fetch and reuse the D.16
 * envelope-to-error mapping.
 */
export async function putOwnerships(apartmentId: string, body: SetOwnerships): Promise<void> {
  // FE-side defensive parse — never PUT a malformed body. A failed
  // parse throws ZodError to the caller (NOT an ApiClientError).
  SetOwnershipsInput.parse(body);
  const res = await fetch(`/api/v1/apartments/${apartmentId}/ownerships`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  let env: { error: { code: string; message?: string; details?: unknown } };
  try {
    env = (await res.json()) as typeof env;
  } catch {
    throw new ApiClientError({ code: 'invalid_response' });
  }
  throw new ApiClientError(env.error);
}
