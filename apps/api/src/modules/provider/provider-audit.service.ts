/**
 * D.37 / Phase 6.5 — Provider Admin cross-tenant audit search.
 *
 * `GET /provider/audit` — searches the ORG-tier `audit_log` table
 * across all tenants (BYPASSRLS via withProvider). NOT to be confused
 * with `provider_audit_log` (the table where Provider's OWN actions
 * land). This endpoint reads the customers' audit trail; the
 * `provider.audit.searched` row it WRITES goes into the provider
 * audit table.
 *
 * Filters (all optional; AND-combined):
 *   - orgId    — exact match
 *   - action   — PREFIX match (e.g. 'import.' → all import.* rows).
 *                Symmetric with the writer's action regex (P6.5-1
 *                hardening guarantees writer side; reader side is
 *                Zod-validated identically).
 *   - fromDate — inclusive lower bound on created_at
 *   - toDate   — inclusive upper bound on created_at
 *
 * Cursor pagination on (created_at DESC, id DESC) — same opaque
 * keyset cursor as every other paginated endpoint (D.16).
 *
 * Audit row written: `action='provider.audit.searched'` with
 * `metadata.filter` snapshot (full query for forensics) +
 * `metadata.reason`.
 *
 * D.16 envelope: { data: ProviderAuditItem[], page: {...} }.
 *
 * No PII surface: org-tier `audit_log` is structured + sanitised at
 * write time (per v8.5 SOLID #7 fix). The Provider sees only what
 * customers' own admins see — same fields, no decryption.
 */
import { auditLog, withProvider } from '@emapp/db';
import type { ApiList, ProviderAuditItem, ProviderAuditQuery } from '@emapp/shared-types';
import { BadRequestException, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, like, lt, lte, or, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';

import type { ProviderActor } from './current-provider.decorator';

/**
 * **Audit v1.1 SA-5 (MEDIUM) closure.** The Provider audit-search
 * SELECT MUST stay an explicit per-column allowlist. The org-tier
 * `audit_log` table includes `before_state`, `after_state`,
 * `actor_email`, `ip`, `user_agent` columns — the v8.5 SOLID #7 fix
 * sanitises `metadata` of cleartext PII, but the same was NEVER
 * enforced systematically for `before_state` / `after_state` (any
 * future writer could spill PII there). A single refactor that
 * widens this projection (e.g. `select()` → `selectAll`) would leak
 * cross-tenant PII.
 *
 * The frozen-allowlist below is asserted by
 * `provider-audit-projection.spec.ts` (SA-5 pin): CI fails the
 * moment a contributor adds a key to the SELECT without updating
 * the allowlist + reviewing the PII surface.
 *
 * Exported so tests can compare against the source of truth without
 * re-parsing the service file.
 */
export const PROVIDER_AUDIT_SELECT_KEYS = [
  'id',
  'organizationId',
  'actorId',
  'actorType',
  'action',
  'targetTable',
  'targetId',
  'createdAt',
] as const;

@Injectable()
export class ProviderAuditService {
  async search(
    actor: ProviderActor,
    reason: string,
    query: ProviderAuditQuery,
  ): Promise<ApiList<ProviderAuditItem>> {
    // Decode cursor BEFORE entering withProvider — fail fast on bad input.
    let cursorDecoded: { createdAt: Date; id: string } | null = null;
    if (query.cursor) {
      const dec = decodeCursor(query.cursor);
      if (!dec) {
        throw new BadRequestException({
          error: { code: 'invalid_cursor', message: 'Cursor is malformed' },
        });
      }
      cursorDecoded = { createdAt: new Date(dec.c), id: dec.i };
    }

    const fetchLimit = query.limit + 1;

    // Build the WHERE predicate up-front so it's clear which filters
    // are AND-combined.
    const filters: SQL[] = [];
    if (query.orgId) filters.push(eq(auditLog.orgId, query.orgId));
    if (query.action) {
      // PREFIX match — `LIKE 'import.%'`. The query-shape regex
      // already disallowed `%` / `_` (only alphanumerics + dot/dash/
      // underscore), so we can append `%` directly without escaping.
      filters.push(like(auditLog.action, `${query.action}%`));
    }
    if (query.fromDate) filters.push(gte(auditLog.createdAt, query.fromDate));
    if (query.toDate) filters.push(lte(auditLog.createdAt, query.toDate));
    if (cursorDecoded) {
      filters.push(
        or(
          lt(auditLog.createdAt, cursorDecoded.createdAt),
          and(eq(auditLog.createdAt, cursorDecoded.createdAt), lt(auditLog.id, cursorDecoded.id)),
        )!,
      );
    }
    const wherePred = filters.length === 0 ? undefined : and(...filters);

    const rows = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        return tx
          .select({
            id: auditLog.id,
            organizationId: auditLog.orgId,
            actorId: auditLog.actorId,
            actorType: auditLog.actorType,
            action: auditLog.action,
            targetTable: auditLog.targetTable,
            targetId: auditLog.targetId,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(wherePred)
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
          .limit(fetchLimit);
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'audit_log',
        action: 'provider.audit.searched',
        metadata: {
          endpoint: 'audit-search',
          filter: {
            orgId: query.orgId ?? null,
            action: query.action ?? null,
            fromDate: query.fromDate ? query.fromDate.toISOString() : null,
            toDate: query.toDate ? query.toDate.toISOString() : null,
            limit: query.limit,
            cursor: query.cursor ?? null,
          },
        },
      },
    );

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const next = hasMore && page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = next ? encodeCursor({ createdAt: next.createdAt, id: next.id }) : null;

    return {
      data: page.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        actorId: r.actorId,
        // actorType column is `text` with a CHECK; we already restrict
        // to {'user','system','provider'} at the writer; Zod shape on
        // the wire is the same enum.
        actorType: r.actorType as ProviderAuditItem['actorType'],
        action: r.action,
        targetTable: r.targetTable,
        targetId: r.targetId,
        createdAt: r.createdAt,
      })),
      page: {
        limit: query.limit,
        cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }
}
