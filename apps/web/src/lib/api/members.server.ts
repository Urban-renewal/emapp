/**
 * Server-only Members API — the RSC-prefetch twin of `lib/api/members.ts`
 * (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `members.ts`) on purpose: `members.ts` is
 * imported by `'use client'` pages/hooks, and pulling `next/headers` (via
 * `server-api.ts`) into that graph breaks the client build. Keeping the server
 * fetch here means the client bundle never sees `next/headers`, and the server
 * prefetch still runs the IDENTICAL defensive Zod parse (`MemberSchema` +
 * `PageSchema`) so the dehydrated cache entry is byte-identical to what the
 * client `listMembers` queryFn produces — the hook's `select` adapter then
 * runs client-side exactly as today.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import { MemberSchema } from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';
import type { MemberListPage } from './members';
import { PageSchema } from './paging';

/**
 * Server-side `GET /api/v1/members` for the page prefetch. Forwards the
 * httpOnly `access_token` cookie via {@link serverApiGet}. Throws an
 * `ApiClientError` on ANY failure; the throw is caught inside `prefetchQuery` /
 * `prefetchToDehydratedState`, so the failure mode is an empty dehydrated
 * cache → the client hook transparently refetches. It NEVER throws out of the
 * Server Component render. (Members is Manager-only — a non-Manager session's
 * forwarded cookie yields a 403 → empty cache → the client surfaces the same
 * `loadFailed` UI as today.)
 */
export async function serverListMembers(query: {
  limit?: number;
  cursor?: string;
}): Promise<MemberListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();

  const body = await serverApiGet(`/members${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page } = body as { data: unknown; page: unknown };
  // SAME parse as the client `listMembers` — the wire is the source of truth.
  const items = z.array(MemberSchema).parse(data);
  return { items, page: PageSchema.parse(page) };
}
