/**
 * Server-only Signature-pulse API — the RSC-prefetch twin of
 * `lib/api/signature-pulse.ts` (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `signature-pulse.ts`) on purpose: that file
 * is imported by `'use client'` hooks, and pulling `next/headers` (via
 * `server-api.ts`) into that graph breaks the client build. Keeping the server
 * fetch here means the client bundle never sees `next/headers`, and the server
 * prefetch still runs the IDENTICAL defensive Zod parse (`SignaturePulseSchema`)
 * so the dehydrated cache entry is byte-identical to what the client
 * `getSignaturePulse` queryFn produces — the hook's `select` adapter then runs
 * client-side exactly as today.
 *
 * The endpoint is scope-aware on the BE (manager/viewer → whole org; agent →
 * assigned projects only); the FE never re-scopes. NO PII reaches here — only
 * counts, derived percentages, timestamps, and project ids/names.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import { SignaturePulseSchema, type SignaturePulse } from '@emapp/shared-types';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';

/**
 * Server-side `GET /api/v1/org/signature-pulse` for the page prefetch. Forwards
 * the httpOnly `access_token` cookie via {@link serverApiGet}. Throws an
 * `ApiClientError` on ANY failure; the throw is caught inside `prefetchQuery` /
 * `prefetchToDehydratedState`, so the failure mode is an empty dehydrated cache
 * → the client hook transparently refetches. It NEVER throws out of the Server
 * Component render.
 */
export async function serverGetSignaturePulse(): Promise<SignaturePulse> {
  const body = await serverApiGet('/org/signature-pulse');
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  // SAME parse as the client `getSignaturePulse` — wire is the source of truth.
  return SignaturePulseSchema.parse((body as { data: unknown }).data);
}
