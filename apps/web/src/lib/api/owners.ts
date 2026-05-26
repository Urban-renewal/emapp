/**
 * Owner API client.
 *
 * PII rules (CLAUDE.md / Doc 07):
 *  - national_id + phone are pgcrypto-encrypted server-side; the wire
 *    only carries MASKED forms (`nationalIdMasked` / `phoneMasked`).
 *  - SEARCH by PII MUST go in the REQUEST BODY (POST /owners/search) —
 *    NEVER as a query param. Query strings leak into proxy access
 *    logs / browser history / Sentry breadcrumbs; the body does not.
 *  - The client never URL-encodes a national_id or phone anywhere.
 */
import { OwnerSchema, type CreateOwner, type Owner, type OwnerSearch } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const OwnerDataSchema = z.object({ data: OwnerSchema });

export interface OwnerListPage {
  items: Owner[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listOwners(
  query: { limit?: number; cursor?: string } = {},
): Promise<OwnerListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/owners${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(OwnerSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getOwner(id: string): Promise<Owner> {
  const res = await apiClient.get<unknown>(`/owners/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerDataSchema.parse({ data: res.data }).data;
}

export async function createOwner(body: CreateOwner): Promise<Owner> {
  // §v9-P0-3 — idempotent create POST.
  const res = await apiClient.postIdempotent<unknown>(`/owners`, body);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerDataSchema.parse({ data: res.data }).data;
}

export async function archiveOwner(id: string): Promise<void> {
  const res = await apiClient.delete<unknown>(`/owners/${id}`);
  if (isOk(res)) return;
  if (isEmptyResponseSuccess(res.error)) return;
  throw new ApiClientError(res.error);
}

/** PII-safe search — POST /owners/search with national_id or phone
 *  in the BODY (never the URL). 404 → null (no-oracle pattern). */
export async function searchOwner(body: OwnerSearch): Promise<Owner | null> {
  const res = await apiClient.post<unknown>(`/owners/search`, body);
  if (isOk(res)) return OwnerDataSchema.parse({ data: res.data }).data;
  if (res.error.code === 'not_found') return null;
  throw new ApiClientError(res.error);
}
