/**
 * Server-only Tasks API — the RSC-prefetch twin of `lib/api/tasks.ts`
 * (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `tasks.ts`) on purpose: `tasks.ts` is
 * imported by `'use client'` pages/hooks, and pulling `next/headers` (via
 * `server-api.ts`) into that graph breaks the client build. Keeping the server
 * fetch here means the client bundle never sees `next/headers`, and the server
 * prefetch still runs the IDENTICAL defensive Zod parse (`TaskSchema` +
 * `PageSchema`) so the dehydrated cache entry is byte-identical to what the
 * client `listTasks` queryFn produces — the hook's `select` adapter then runs
 * client-side exactly as today.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import { TaskSchema, type Task } from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';
import type { TaskListPage } from './tasks';

/**
 * Server-side `GET /api/v1/tasks` for the page prefetch. Forwards the httpOnly
 * `access_token` cookie via {@link serverApiGet}. Throws an `ApiClientError`
 * on ANY failure; the throw is caught inside `prefetchQuery` /
 * `prefetchToDehydratedState`, so the failure mode is an empty dehydrated
 * cache → the client hook transparently refetches. It NEVER throws out of the
 * Server Component render.
 */
export async function serverListTasks(query: {
  limit?: number;
  cursor?: string;
}): Promise<TaskListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();

  const body = await serverApiGet(`/tasks${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page } = body as { data: unknown; page: unknown };
  // SAME parse as the client `listTasks` — the wire is the source of truth.
  const items = z.array(TaskSchema).parse(data);
  return { items, page: PageSchema.parse(page) };
}

/**
 * Server-side `GET /api/v1/tasks/:id` for the DETAIL page prefetch. Runs the
 * IDENTICAL `TaskSchema` parse as the client `getTask`. Throws an
 * `ApiClientError` on ANY failure; the throw is caught inside `prefetchQuery` /
 * `prefetchToDehydratedState`, so a failure degrades to an empty dehydrated
 * cache → the client `useTask` hook transparently refetches. NEVER throws out
 * of the Server Component render. NOTE: the BE service-layer-scopes an Agent to
 * their OWN assigned tasks — a non-assigned task 404s server-side, the prefetch
 * yields an empty cache, and the client renders the existing not-found UI.
 */
export async function serverGetTask(id: string): Promise<Task> {
  const body = await serverApiGet(`/tasks/${id}`);
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data } = body as { data: unknown };
  return TaskSchema.parse(data);
}
