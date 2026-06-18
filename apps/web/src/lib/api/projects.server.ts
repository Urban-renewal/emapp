/**
 * Server-only Projects API — the RSC-prefetch twin of `lib/api/projects.ts`
 * (perf-research/01-rsc-waterfall.md §2.4 / §4.2).
 *
 * Lives in a SEPARATE module (not in `projects.ts`) on purpose: `projects.ts`
 * is imported by `'use client'` pages (e.g. `buildings/[id]/page.tsx`), and
 * pulling `next/headers` (via `server-api.ts`) into that graph breaks the
 * client build ("next/headers only works in a Server Component"). Keeping the
 * server fetch here means the client bundle never sees `next/headers`, and the
 * server prefetch still runs the IDENTICAL defensive Zod parse
 * (`ProjectListItemSchema` + `PageSchema`) so the dehydrated cache entry is
 * byte-identical to what the client `listProjects` queryFn produces — the
 * hook's `select` adapter then runs client-side exactly as today.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack §4.7).
 */
import { ProjectListItemSchema, type ProjectListItem } from '@emapp/shared-types';
import { z } from 'zod';

import { serverApiGet } from '../server-api';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';
import type { ProjectListPage } from './projects';

/**
 * Server-side `GET /api/v1/projects` for the page prefetch. Forwards the
 * httpOnly `access_token` cookie via {@link serverApiGet} (reusing getMe's
 * §v9-H-1 host-allowlist + 15s-timeout posture). Throws an `ApiClientError`
 * on ANY failure — refused Host, missing/expired cookie, non-2xx, timeout,
 * malformed JSON, or a wire shape that fails the parse. The throw is caught
 * inside TanStack's `prefetchQuery` (and again by `prefetchToDehydratedState`),
 * so the failure mode is an empty dehydrated cache → the client hook
 * transparently refetches with its existing loading/error UI. It NEVER
 * throws out of the Server Component render.
 */
export async function serverListProjects(query: {
  limit?: number;
  cursor?: string;
}): Promise<ProjectListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();

  const body = await serverApiGet(`/projects${qs ? `?${qs}` : ''}`);
  if (!body || typeof body !== 'object' || !('data' in body) || !('page' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data, page } = body as { data: unknown; page: unknown };
  // SAME parse as the client `listProjects` — the wire is the source of truth.
  const items = z.array(ProjectListItemSchema).parse(data);
  return { items, page: PageSchema.parse(page) };
}

/**
 * Server-side `GET /api/v1/projects/:id` for the DETAIL page prefetch. Runs the
 * IDENTICAL parse as the client `getProject` — the single-record GET carries
 * the aggregate stats, so it parses against `ProjectListItemSchema` (NOT the
 * bare `ProjectSchema`, which would strip the stats fields). Throws an
 * `ApiClientError` on ANY failure; the throw is caught inside `prefetchQuery` /
 * `prefetchToDehydratedState`, so a failure degrades to an empty dehydrated
 * cache → the client `useProject` hook transparently refetches. NEVER throws
 * out of the Server Component render.
 */
export async function serverGetProject(id: string): Promise<ProjectListItem> {
  const body = await serverApiGet(`/projects/${id}`);
  if (!body || typeof body !== 'object' || !('data' in body)) {
    throw new ApiClientError({ code: 'invalid_response', message: 'server prefetch failed' });
  }
  const { data } = body as { data: unknown };
  return ProjectListItemSchema.parse(data);
}
