/**
 * D.37 / Phase 6.5 — Provider Admin tenant LIST service.
 *
 * `GET /provider/tenants` — paginated list of every organization
 * (BYPASSRLS via `withProvider`), with aggregated counts. PII-free at
 * this surface (org name + slug are not D.19 PII; per-org counts are
 * aggregates). The tenant DETAIL endpoint (P6.5-3) is where masked
 * sample owners surface.
 *
 * Audit row written for every call: `action='provider.tenant.viewed'`
 * with `metadata.endpoint='list'` + `metadata.filter` (cursor/limit
 * snapshot). The wrapper's foundational invariant (T6.5-D37-0)
 * guarantees `metadata.reason` is also populated.
 *
 * Cursor pagination on `(createdAt DESC, id DESC)` — same opaque
 * keyset cursor as the org-tier endpoints (D.16 says cursor-only,
 * never offset).
 */
import { organizations, withProvider } from '@emapp/db';
import type { ApiList, ListTenantsQuery, TenantListItem } from '@emapp/shared-types';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import { decodeCursorOrThrow, encodeCursor } from '../../common/keyset-cursor';

import type { ProviderActor } from './current-provider.decorator';

@Injectable()
export class ProviderTenantsService {
  /**
   * List organizations with aggregated counts.
   *
   * Counts are computed via correlated subqueries in a single round-
   * trip — N+1 would be unacceptable for a Provider dashboard view
   * (already cross-tenant, multiplied by page size). The subquery
   * shape pushes the count down into Postgres which can plan-prune
   * via the org-id indexes on each child table.
   */
  async list(
    actor: ProviderActor,
    reason: string,
    query: ListTenantsQuery,
  ): Promise<ApiList<TenantListItem>> {
    // Decode cursor BEFORE entering withProvider — invalid cursor is
    // a client error (400), no point opening a Provider session for it.
    // SA-11: `decodeCursorOrThrow` centralises the 4-line decode+throw
    // pattern that was duplicated across provider services.
    let cursorDecoded: { createdAt: Date; id: string } | null = null;
    if (query.cursor) {
      const dec = decodeCursorOrThrow(query.cursor);
      cursorDecoded = { createdAt: new Date(dec.c), id: dec.i };
    }

    // Fetch limit+1 so we can compute `has_more` without a second
    // round-trip. Standard keyset trick.
    const fetchLimit = query.limit + 1;

    const rows = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        // Correlated subqueries for counts — single query, planner-
        // friendly. Each child table has an org-id index.
        //
        // Subqueries use raw qualified column names ("organizations"."id")
        // rather than drizzle's `${organizations.id}` interpolation.
        // The drizzle interpolation can emit unqualified `"id"` when
        // the column name collides with a column in the subquery's
        // FROM clause (e.g. `users.id` here), producing the pg error
        // `42702: column reference "id" is ambiguous`. Explicit
        // qualification eliminates that class of bug.
        const usersCount = sql<number>`(
          SELECT COUNT(*)::int
          FROM users u
          INNER JOIN memberships m ON m.user_id = u.id
          WHERE m.org_id = "organizations"."id"
            AND m.revoked_at IS NULL
            AND u.archived_at IS NULL
        )`.as('users_count');
        const projectsCount = sql<number>`(
          SELECT COUNT(*)::int FROM projects p
          WHERE p.org_id = "organizations"."id"
            AND p.archived_at IS NULL
        )`.as('projects_count');
        const ownersCount = sql<number>`(
          SELECT COUNT(*)::int FROM owners o
          WHERE o.org_id = "organizations"."id"
            AND o.archived_at IS NULL
        )`.as('owners_count');

        // Cursor predicate: (createdAt < c) OR (createdAt = c AND id < i)
        // — strict less-than to avoid re-emitting the cursor row.
        const cursorPred = cursorDecoded
          ? or(
              lt(organizations.createdAt, cursorDecoded.createdAt),
              and(
                eq(organizations.createdAt, cursorDecoded.createdAt),
                lt(organizations.id, cursorDecoded.id),
              ),
            )
          : undefined;

        return tx
          .select({
            id: organizations.id,
            name: organizations.name,
            slug: organizations.slug,
            createdAt: organizations.createdAt,
            archivedAt: organizations.archivedAt,
            suspendedAt: organizations.suspendedAt,
            usersCount,
            projectsCount,
            ownersCount,
          })
          .from(organizations)
          .where(cursorPred)
          .orderBy(desc(organizations.createdAt), desc(organizations.id))
          .limit(fetchLimit);
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'organizations',
        action: 'provider.tenant.viewed',
        metadata: {
          endpoint: 'list',
          // Filter snapshot — useful for forensics ("which page was the
          // Provider on?"). `cursor` is opaque base64; safe to log.
          filter: {
            limit: query.limit,
            cursor: query.cursor ?? null,
          },
        },
      },
    );

    // Split off the lookahead row (if present) to compute has_more.
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const next = hasMore && page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = next ? encodeCursor({ createdAt: next.createdAt, id: next.id }) : null;

    return {
      data: page.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        createdAt: r.createdAt,
        archivedAt: r.archivedAt,
        suspendedAt: r.suspendedAt,
        counts: {
          users: Number(r.usersCount),
          projects: Number(r.projectsCount),
          owners: Number(r.ownersCount),
        },
      })),
      page: {
        limit: query.limit,
        cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }
}
