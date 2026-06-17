/**
 * Server-only Notifications API — the RSC-prefetch twin of
 * `lib/api/notifications.ts` (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `notifications.ts`) on purpose:
 * `notifications.ts` is imported by `'use client'` pages/hooks (and the topbar
 * bell), and pulling `next/headers` (via `server-api.ts`) into that graph
 * breaks the client build ("next/headers only works in a Server Component").
 * Keeping the server fetch here means the client bundle never sees
 * `next/headers`, and the server prefetch still runs the IDENTICAL defensive
 * Zod parse (`NotificationSchema` + `PageSchema`) so the dehydrated cache entry
 * is byte-identical to what the client `listNotifications` queryFn produces —
 * the hook's `select` adapter then runs client-side exactly as today.
 *
 * Scope: this prefetches the FULL-PAGE list slot (`{ limit: 25 }`). The topbar
 * bell's `{ limit: 5 }` GET is a different cache slot in a different component
 * and is intentionally left untouched.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import { NotificationSchema } from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';
import { type NotificationListPage } from './notifications';
import { PageSchema } from './paging';

/**
 * Server-side `GET /api/v1/notifications` for the page prefetch. Forwards the
 * httpOnly `access_token` cookie via {@link serverApiGet} (reusing getMe's
 * §v9-H-1 host-allowlist + 15s-timeout posture). Throws an `ApiClientError`
 * on ANY failure — refused Host, missing/expired cookie, non-2xx, timeout,
 * malformed JSON, or a wire shape that fails the parse. The throw is caught
 * inside TanStack's `prefetchQuery` (and again by `prefetchToDehydratedState`),
 * so the failure mode is an empty dehydrated cache → the client hook
 * transparently refetches with its existing loading/error UI. It NEVER throws
 * out of the Server Component render.
 */
export async function serverListNotifications(query: {
  limit?: number;
  cursor?: string;
}): Promise<NotificationListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();

  const body = await serverApiGet(`/notifications${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page } = body as { data: unknown; page: unknown };
  // SAME parse as the client `listNotifications` — the wire is the source of truth.
  const items = z.array(NotificationSchema).parse(data);
  return { items, page: PageSchema.parse(page) };
}
