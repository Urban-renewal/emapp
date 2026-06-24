/**
 * Server-only Signature-requests API — the RSC-prefetch twin of
 * `lib/api/signature-requests.ts` (perf-research/01-rsc-waterfall.md §2.4 /
 * §4.2).
 *
 * Lives in a SEPARATE module (not in `signature-requests.ts`) on purpose: that
 * file is imported by `'use client'` pages/hooks, and pulling `next/headers`
 * (via `server-api.ts`) into that graph breaks the client build. Keeping the
 * server fetch here means the client bundle never sees `next/headers`, and the
 * server prefetch still runs the IDENTICAL defensive Zod parse
 * (`SignatureRequestListItemSchema` + `PageSchema`) so the dehydrated cache
 * entry is byte-identical to what the client `listSignatureRequests` queryFn
 * produces — the hook's `select` adapter then runs client-side exactly as today.
 * Slice-3: the list wire is the ENRICHED row (project / apartment / document /
 * masked-default owner), so server and client MUST parse with the SAME list-item
 * schema or the dehydrated entry would drop the display fields.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import {
  SignatureRequestListItemSchema,
  type ListSignatureRequestsQueryDto,
} from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';
import type { SignatureRequestListPage } from './signature-requests';

/**
 * Server-side `GET /api/v1/signature-requests` for the page prefetch. Forwards
 * the httpOnly `access_token` cookie via {@link serverApiGet}. Throws an
 * `ApiClientError` on ANY failure; the throw is caught inside `prefetchQuery` /
 * `prefetchToDehydratedState`, so the failure mode is an empty dehydrated
 * cache → the client hook transparently refetches. It NEVER throws out of the
 * Server Component render.
 */
export async function serverListSignatureRequests(
  query: Partial<ListSignatureRequestsQueryDto>,
): Promise<SignatureRequestListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.status) params.set('status', query.status);
  if (query.documentId) params.set('documentId', query.documentId);
  if (query.ownerId) params.set('ownerId', query.ownerId);
  if (query.projectId) params.set('projectId', query.projectId);
  const qs = params.toString();

  const body = await serverApiGet(`/signature-requests${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page } = body as { data: unknown; page: unknown };
  // SAME parse as the client `listSignatureRequests` — wire is the source of
  // truth; the enriched list-item schema surfaces the display context.
  const items = z.array(SignatureRequestListItemSchema).parse(data);
  return { items, page: PageSchema.parse(page) };
}
