/**
 * Server-only Contractors API — the RSC-prefetch twin of
 * `lib/api/contractors.ts` (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `contractors.ts`) on purpose:
 * `contractors.ts` is imported by `'use client'` pages/hooks, and pulling
 * `next/headers` (via `server-api.ts`) into that graph breaks the client build
 * ("next/headers only works in a Server Component"). Keeping the server fetch
 * here means the client bundle never sees `next/headers`, and the server
 * prefetch still runs the IDENTICAL defensive Zod parse (`ContractorSchema` +
 * `PageSchema`) so the dehydrated cache entry is byte-identical to what the
 * client `listContractors` queryFn produces — the hook's `select` adapter then
 * runs client-side exactly as today.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import { ContractorSchema } from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ContractorFacetsSchema, type ContractorListPage } from './contractors';
import { ApiClientError } from './errors';
import { PageSchema } from './paging';

/**
 * Server-side `GET /api/v1/contractors` for the page prefetch. Forwards the
 * httpOnly `access_token` cookie via {@link serverApiGet} (reusing getMe's
 * §v9-H-1 host-allowlist + 15s-timeout posture). Throws an `ApiClientError`
 * on ANY failure — refused Host, missing/expired cookie, non-2xx, timeout,
 * malformed JSON, or a wire shape that fails the parse. The throw is caught
 * inside TanStack's `prefetchQuery` (and again by `prefetchToDehydratedState`),
 * so the failure mode is an empty dehydrated cache → the client hook
 * transparently refetches with its existing loading/error UI. It NEVER throws
 * out of the Server Component render.
 */
export async function serverListContractors(query: {
  limit?: number;
  cursor?: string;
}): Promise<ContractorListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();

  const body = await serverApiGet(`/contractors${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page, facets } = body as { data: unknown; page: unknown; facets?: unknown };
  // SAME parse as the client `listContractors` — the wire is the source of truth,
  // INCLUDING the `facets` field, so the dehydrated cache entry is byte-identical
  // to what the client queryFn would produce (the hook's `select` then runs the
  // same way on the seeded cache).
  const items = z.array(ContractorSchema).parse(data);
  const parsedFacets = ContractorFacetsSchema.parse(facets ?? undefined);
  return { items, facets: parsedFacets, page: PageSchema.parse(page) };
}
