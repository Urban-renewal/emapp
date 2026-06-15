/**
 * P4 / PLAN-provider-console §3 Tier-1 #1 — Provider Admin "org users
 * management" service.
 *
 * `GET /provider/tenants/:id/users` — the target org's MEMBERS, READ-ONLY
 * + PII-MASKED + cross-tenant (BYPASSRLS via `withProvider`) + audited.
 *
 * Same posture as `ProviderTenantDetailService` (the wired org-detail
 * sample-owners surface), adapted for the membership graph:
 *   - `withProvider(providerUserId, reason, fn, { action, ... })` — every
 *     read writes a `provider_audit_log` row (action
 *     `provider.tenant.users.viewed`, target_table='memberships',
 *     target_record_id=<orgId>). The mandatory access-reason rides along
 *     (the wrapper's foundational invariant guarantees `metadata.reason`).
 *   - PII MASKED IN-SQL — no cleartext name/email leaves Postgres.
 *       name  → `'•••••••' || right(name, 2)`   (last-2 chars)
 *       email → `left(email,1) || '•••@' || split_part(email,'@',2)`
 *               (first char of local-part + domain; e.g. `a•••@acme.co`)
 *     Member name + email are NOT pgcrypto columns (plain text/citext on
 *     `users`), but the Provider tier still NEVER sees full customer PII —
 *     so the masking is applied here, in-SQL, exactly like the owner
 *     sample. national_id / phone are NOT columns on this surface and are
 *     never selected.
 *   - There is NO reveal flow — masked only (MVP; the Provider tier has no
 *     field-level unmask at this surface).
 *
 * Cursor pagination on `(memberships.created_at DESC, memberships.id DESC)`
 * — the same opaque keyset cursor the tenant-list endpoint uses, backed by
 * `idx_memberships_org_created`. We do NOT filter on `revoked_at IS NULL`
 * (unlike the detail-counts): the support operator's #1 task is seeing
 * revoked/invited members too, so all lifecycle states are returned and
 * the `status` field distinguishes them.
 *
 * 404 semantics: mirrors the detail endpoint — a random/non-existent org
 * id throws `NotFoundException` (`tenant_not_found`, D.16 envelope). The
 * audit-first interceptor + `withProvider` still write a row for the
 * attempt regardless.
 */
import { organizations, withProvider } from '@emapp/db';
import type { ApiList, ListTenantUsersQuery, TenantUserItem } from '@emapp/shared-types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { decodeCursorOrThrow, encodeCursor, type KeysetCursor } from '../../common/keyset-cursor';

import type { ProviderActor } from './current-provider.decorator';

// Type alias (not interface) so drizzle's `tx.execute<T>` accepts it — its
// constraint is `Record<string, unknown>` and interface declarations do
// NOT satisfy that constraint structurally (TS2344). Aliases DO.
type MemberRow = {
  id: string;
  userId: string;
  nameMasked: string;
  emailMasked: string;
  role: string;
  roleKeys: string[];
  status: 'invited' | 'active' | 'revoked';
  isPrimary: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class ProviderTenantUsersService {
  async list(
    actor: ProviderActor,
    reason: string,
    tenantId: string,
    query: ListTenantUsersQuery,
  ): Promise<ApiList<TenantUserItem>> {
    // Decode the cursor BEFORE entering withProvider — a malformed cursor
    // is a client error (400 invalid_cursor), no point opening a Provider
    // session for it (SA-11 helper).
    let cursorDecoded: KeysetCursor | null = null;
    if (query.cursor) {
      cursorDecoded = decodeCursorOrThrow(query.cursor);
    }

    // Fetch limit+1 so `has_more` is computed without a second round-trip.
    const fetchLimit = query.limit + 1;

    const result = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        // First confirm the org exists — so a random uuid is a clean 404
        // (same "no oracle needed" rationale as the detail endpoint:
        // BYPASSRLS sees everything, a missing row genuinely means absent).
        const orgRows = await tx.execute<{ id: string }>(sql`
          SELECT o.id AS "id"
          FROM ${organizations} o
          WHERE o.id = ${tenantId}
          LIMIT 1
        `);
        if (!orgRows.rows[0]) return null;

        // Members of the org, PII MASKED IN-SQL. Cursor predicate is a
        // strict keyset on (created_at, id) to avoid re-emitting the
        // cursor row. national_id / phone are NOT columns here and are
        // never selected. role_assignments are aggregated to surface any
        // ORG-SCOPE custom role keys the member holds (system + custom).
        const rows = await tx.execute<MemberRow>(sql`
          SELECT
            m.id AS "id",
            m.user_id AS "userId",
            ('•••••••' || right(u.name, 2)) AS "nameMasked",
            (left(u.email::text, 1) || '•••@' || split_part(u.email::text, '@', 2)) AS "emailMasked",
            m.role AS "role",
            COALESCE(
              (
                SELECT array_agg(DISTINCT r.key ORDER BY r.key)
                FROM role_assignments ra
                INNER JOIN roles r ON r.id = ra.role_id
                WHERE ra.user_id = m.user_id
                  AND ra.scope_type = 'org'
                  AND ra.scope_id = m.org_id
                  AND (ra.expires_at IS NULL OR ra.expires_at > now())
              ),
              ARRAY[]::text[]
            ) AS "roleKeys",
            CASE
              WHEN m.revoked_at IS NOT NULL THEN 'revoked'
              WHEN m.accepted_at IS NULL THEN 'invited'
              ELSE 'active'
            END AS "status",
            m.is_primary AS "isPrimary",
            u.last_login_at AS "lastLoginAt",
            m.created_at AS "createdAt"
          FROM memberships m
          INNER JOIN users u ON u.id = m.user_id
          WHERE m.org_id = ${tenantId}
            ${
              cursorDecoded
                ? sql`AND (
                    date_trunc('milliseconds', m.created_at) < ${cursorDecoded.c}::timestamptz
                    OR (date_trunc('milliseconds', m.created_at) = ${cursorDecoded.c}::timestamptz AND m.id < ${cursorDecoded.i})
                  )`
                : sql``
            }
          ORDER BY date_trunc('milliseconds', m.created_at) DESC, m.id DESC
          LIMIT ${fetchLimit}
        `);

        return rows.rows;
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'memberships',
        targetRecordId: tenantId,
        action: 'provider.tenant.users.viewed',
        metadata: {
          endpoint: 'users',
          tenantId,
          filter: {
            limit: query.limit,
            cursor: query.cursor ?? null,
          },
        },
      },
    );

    if (result === null) {
      throw new NotFoundException({
        error: {
          code: 'tenant_not_found',
          message: `No tenant found for id`,
        },
      });
    }

    // Split off the lookahead row (if present) to compute has_more.
    // Raw `tx.execute` returns timestamp columns as ISO strings (NOT Date
    // objects, unlike drizzle's typed `.select()`), so coerce before any
    // Date use (encodeCursor / the wire shape, which Zod re-parses anyway).
    const hasMore = result.length > query.limit;
    const page = hasMore ? result.slice(0, query.limit) : result;
    const next = hasMore && page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = next
      ? encodeCursor({ createdAt: new Date(next.createdAt), id: next.id })
      : null;

    return {
      data: page.map((r) => ({
        id: r.id,
        userId: r.userId,
        nameMasked: r.nameMasked,
        emailMasked: r.emailMasked,
        role: r.role,
        roleKeys: r.roleKeys ?? [],
        status: r.status,
        isPrimary: r.isPrimary,
        lastLoginAt: r.lastLoginAt === null ? null : new Date(r.lastLoginAt),
        createdAt: new Date(r.createdAt),
      })),
      page: {
        limit: query.limit,
        cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }
}
