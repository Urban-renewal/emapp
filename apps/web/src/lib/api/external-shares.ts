/**
 * External-share ("invite a party") API client — V13 X-S6/X-S7.
 *
 * The party-typed external-sharing grant (developer / lawyer / bank / appraiser
 * / …) — the documents-process Collaboration SHARE-TO verb. This is the FE
 * consumer of the FULLY-BUILT `external_share` BE (controller #507). It is
 * SEPARATE from the legacy contractor `shares.ts` path — do NOT conflate.
 *
 * Routes (the wire already exists — apps/api/.../external-shares.controller.ts):
 *   GET    /api/v1/external-shares              → { data: ExternalShareView[], page }
 *   POST   /api/v1/external-shares              → { data: ExternalShareView }   (Manager)
 *   PATCH  /api/v1/external-shares/:id          → { data: ExternalShareView }   (Manager)
 *   POST   /api/v1/external-shares/:id/extend   → { data: ExternalShareView }   (Manager)
 *   POST   /api/v1/external-shares/:id/resend   → { data: ExternalShareView }   (Manager)
 *   DELETE /api/v1/external-shares/:id          → 204                           (Manager)
 *
 * The preset CEILING per party_type is enforced SERVER-SIDE (fail-closed;
 * `external-shares.service.ts` rejects any widening with `exceeds_ceiling` /
 * `cannot_widen`). The FE only NARROWS. Every body is `.strict()`-validated
 * defensively here BEFORE the wire (matches the BE Zod), so an unknown / over-
 * permissive key fails fast on the client too.
 */
import {
  CreateExternalShareInput,
  ExtendExternalShareInput,
  ExternalShareSchema,
  UpdateExternalShareInput,
  type CreateExternalShare,
  type ExtendExternalShare,
  type ExternalSharePartyType,
  type ExternalShareView,
  type UpdateExternalShare,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const ExternalShareDataSchema = z.object({ data: ExternalShareSchema });

export interface ExternalShareListPage {
  items: ExternalShareView[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export interface ListExternalSharesQuery {
  limit?: number;
  cursor?: string;
  partyType?: ExternalSharePartyType;
}

export async function listExternalShares(
  query: ListExternalSharesQuery = {},
): Promise<ExternalShareListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.partyType) params.set('partyType', query.partyType);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/external-shares${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(ExternalShareSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function createExternalShare(body: CreateExternalShare): Promise<ExternalShareView> {
  // Defensive client-side Zod parse — any over-permissive / unknown perms key
  // fails HERE before the wire (fail-closed; matches BE .strict()). The server
  // STILL re-validates against the party ceiling — this never widens; the
  // narrowing the FE does is purely a UX convenience.
  const validated = CreateExternalShareInput.parse(body);
  const res = await apiClient.postIdempotent<unknown>('/external-shares', validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ExternalShareDataSchema.parse({ data: res.data }).data;
}

export async function updateExternalShare(
  id: string,
  body: UpdateExternalShare,
): Promise<ExternalShareView> {
  const validated = UpdateExternalShareInput.parse(body);
  const res = await apiClient.patch<unknown>(`/external-shares/${id}`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ExternalShareDataSchema.parse({ data: res.data }).data;
}

export async function extendExternalShare(
  id: string,
  body: ExtendExternalShare,
): Promise<ExternalShareView> {
  const validated = ExtendExternalShareInput.parse(body);
  const res = await apiClient.post<unknown>(`/external-shares/${id}/extend`, validated);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ExternalShareDataSchema.parse({ data: res.data }).data;
}

export async function resendExternalShare(id: string): Promise<ExternalShareView> {
  const res = await apiClient.post<unknown>(`/external-shares/${id}/resend`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ExternalShareDataSchema.parse({ data: res.data }).data;
}

export async function revokeExternalShare(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/external-shares/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}
