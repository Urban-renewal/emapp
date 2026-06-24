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
import {
  OwnerListItemSchema,
  OwnerPiiRevealSchema,
  OwnerProjectSummarySchema,
  OwnerSchema,
  type CreateOwner,
  type Owner,
  type OwnerListItem,
  type OwnerPiiReveal,
  type OwnerProjectSummary,
  type OwnerSearch,
} from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError, isEmptyResponseSuccess } from './errors';
import { PageSchema } from './paging';

const OwnerDataSchema = z.object({ data: OwnerSchema });
const OwnerPiiRevealDataSchema = z.object({ data: OwnerPiiRevealSchema });

export interface OwnerListPage {
  items: OwnerListItem[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listOwners(
  query: { limit?: number; cursor?: string; archived?: boolean; needsAttention?: boolean } = {},
): Promise<OwnerListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  // Only send when true — the BE defaults to the active view.
  if (query.archived) params.set('archived', 'true');
  // B2 — only send when on; BE defaults to 'false' (no attention filter).
  if (query.needsAttention) params.set('needsAttention', 'true');
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/owners${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(OwnerListItemSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

/**
 * B1 (findable-at-scale) — server-side owner NAME search via the EXISTING
 * `GET /owners/search` endpoint (`OwnersService.searchByName`). Mirrors
 * {@link listOwners} EXACTLY — same `{data,page}` envelope, same
 * `OwnerListItemSchema` + `PageSchema` parse, same keyset cursor
 * (`createdAt desc, id desc`), same masked PII — so the owners list can SWAP its
 * query source to this when there's a search term and pagination still works.
 *
 * `q` is a NAME (not PII national_id/phone), so it rides the query string — it
 * never leaks a national_id/phone into access logs (the by-PII lookup stays the
 * POST `searchOwner` below, value in the body). The BE decrypts the name IN-SQL
 * and ILIKEs it; national_id/phone come back MASKED, same as the list. `q` is
 * trimmed + bounded server-side; we trim here too so the caller can
 * short-circuit an all-whitespace box. `needsAttention` composes (B2).
 */
export async function searchOwnersByName(query: {
  q: string;
  limit?: number;
  cursor?: string;
  needsAttention?: boolean;
}): Promise<OwnerListPage> {
  const params = new URLSearchParams();
  params.set('q', query.q.trim());
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.needsAttention) params.set('needsAttention', 'true');
  const res = await apiClient.getList<unknown>(`/owners/search?${params.toString()}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(OwnerListItemSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function getOwner(id: string): Promise<Owner> {
  const res = await apiClient.get<unknown>(`/owners/${id}`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerDataSchema.parse({ data: res.data }).data;
}

const OwnerProjectsDataSchema = z.object({ data: z.array(OwnerProjectSummarySchema) });

/**
 * S3d — the DISTINCT projects an owner is tied to via active ownerships
 * (GET /owners/:id/projects). The response carries PROJECTS only — no owner
 * PII (national_id/phone). Defensive `.parse()` (the FE never trusts the wire);
 * the BE org/agent-scopes the list so a caller never sees a project they can't.
 */
export async function getOwnerProjects(id: string): Promise<OwnerProjectSummary[]> {
  const res = await apiClient.get<unknown>(`/owners/${id}/projects`);
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerProjectsDataSchema.parse({ data: res.data }).data;
}

/**
 * D.54 — reveal-on-demand: fetch the CLEARTEXT national_id/phone for ONE
 * owner. POST (not GET) so the owner id never lands in access logs /
 * history and the action is a deliberate, BE-audited (`owner.pii_revealed`)
 * per-owner reveal. The BE gates: view_owners → existence → scope →
 * view_owner_pii (manager always · agent per flag · viewer never → 403).
 *
 * SECURITY: the returned cleartext is transient — the caller MUST hold it
 * in ephemeral component state only and NEVER write it to the TanStack
 * cache, localStorage, the URL, or a log. That is why this is a plain
 * function (not a cached query) and the hook deliberately omits any
 * `setQueryData`.
 */
export async function revealOwnerPii(id: string): Promise<OwnerPiiReveal> {
  const res = await apiClient.post<unknown>(`/owners/${id}/reveal-pii`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return OwnerPiiRevealDataSchema.parse({ data: res.data }).data;
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
