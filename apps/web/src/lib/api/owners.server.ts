/**
 * Server-only Owners API — the RSC-prefetch twin of `lib/api/owners.ts`
 * (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `owners.ts`) on purpose: `owners.ts` is
 * imported by `'use client'` pages/hooks, and pulling `next/headers` (via
 * `server-api.ts`) into that graph breaks the client build ("next/headers
 * only works in a Server Component"). Keeping the server fetch here means the
 * client bundle never sees `next/headers`, and the server prefetch still runs
 * the IDENTICAL defensive Zod parse (`OwnerListItemSchema` + `PageSchema`) so
 * the dehydrated cache entry is byte-identical to what the client `listOwners`
 * queryFn produces — the hook's `select` adapter then runs client-side exactly
 * as today.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import {
  OwnerListItemSchema,
  OwnerProjectSummarySchema,
  OwnerSchema,
  type Owner,
  type OwnerProjectSummary,
} from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';
import type { OwnerListPage } from './owners';
import { PageSchema } from './paging';

/**
 * Server-side `GET /api/v1/owners` for the page prefetch. Forwards the
 * httpOnly `access_token` cookie via {@link serverApiGet} (reusing getMe's
 * §v9-H-1 host-allowlist + 15s-timeout posture). Throws an `ApiClientError`
 * on ANY failure — refused Host, missing/expired cookie, non-2xx, timeout,
 * malformed JSON, or a wire shape that fails the parse. The throw is caught
 * inside TanStack's `prefetchQuery` (and again by `prefetchToDehydratedState`),
 * so the failure mode is an empty dehydrated cache → the client hook
 * transparently refetches with its existing loading/error UI. It NEVER throws
 * out of the Server Component render.
 */
export async function serverListOwners(query: {
  limit?: number;
  cursor?: string;
  archived?: boolean;
  needsAttention?: boolean;
}): Promise<OwnerListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.archived) params.set('archived', 'true');
  // Parity with the client `listOwners` — only set when on (default view omits
  // it, so the prefetch URL stays identical to the client's first fetch).
  if (query.needsAttention) params.set('needsAttention', 'true');
  const qs = params.toString();

  const body = await serverApiGet(`/owners${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page } = body as { data: unknown; page: unknown };
  // SAME parse as the client `listOwners` — the wire is the source of truth.
  const items = z.array(OwnerListItemSchema).parse(data);
  return { items, page: PageSchema.parse(page) };
}

/**
 * Server-side `GET /api/v1/owners/:id` for the DETAIL page prefetch. Runs the
 * IDENTICAL `OwnerSchema` parse as the client `getOwner`.
 *
 * PII: the detail endpoint returns the SAME MASKED projection as the list
 * (`nationalIdMasked` / `phoneMasked`) — NEVER cleartext. The cleartext reveal
 * (`POST /owners/:id/reveal-pii`) is a SEPARATE D.54 step-up endpoint that is
 * never prefetched and never enters the TanStack cache. This prefetch only ever
 * sees masked PII, so it's safe to dehydrate into the (inspectable) cache.
 *
 * Throws an `ApiClientError` on ANY failure; caught inside `prefetchQuery` /
 * `prefetchToDehydratedState` → empty cache → client `useOwner` refetches.
 * NEVER throws out of the Server Component render.
 */
export async function serverGetOwner(id: string): Promise<Owner> {
  const body = await serverApiGet(`/owners/${id}`);
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data } = body as { data: unknown };
  return OwnerSchema.parse(data);
}

/**
 * Server-side `GET /api/v1/owners/:id/projects` for the DETAIL page prefetch
 * (the DISTINCT projects an owner is tied to via active ownerships). Runs the
 * IDENTICAL `z.array(OwnerProjectSummarySchema)` parse as the client
 * `getOwnerProjects`. The response carries PROJECTS only — no owner PII. The BE
 * org/agent-scopes the list. Throws on ANY failure (caught upstream → empty
 * cache → client `useOwnerProjects` refetches). NEVER throws out of the render.
 */
export async function serverGetOwnerProjects(id: string): Promise<OwnerProjectSummary[]> {
  const body = await serverApiGet(`/owners/${id}/projects`);
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data } = body as { data: unknown };
  return z.array(OwnerProjectSummarySchema).parse(data);
}
