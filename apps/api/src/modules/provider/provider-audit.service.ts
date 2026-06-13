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
 * `GET /provider/audit/self` (B-PROVIDER-2) — reads `provider_audit_log`
 * itself, so the provider's OWN actions are now readable in-product (the
 * D.37 accountability payoff: "who on our team accessed customer X, when,
 * why?"). See `selfSearch`. (Perf follow-up: an all-providers ORDER BY
 * started_at is not served by idx_provider_audit_user_time — add a
 * (started_at DESC, id DESC) index before this table grows large.)
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
import { auditLog, providerAuditLog, withProvider } from '@emapp/db';
import type {
  ApiList,
  ProviderAuditItem,
  ProviderAuditQuery,
  ProviderSelfAuditItem,
  ProviderSelfAuditQuery,
} from '@emapp/shared-types';
import { Injectable } from '@nestjs/common';
import { and, eq, gte, like, lte, sql, type SQL } from 'drizzle-orm';

import {
  decodeCursorOrThrow,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
  type KeysetCursor,
} from '../../common/keyset-cursor';

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
    // SA-11: `decodeCursorOrThrow` centralises the decode+throw pattern.
    let cursorDecoded: KeysetCursor | null = null;
    if (query.cursor) {
      cursorDecoded = decodeCursorOrThrow(query.cursor);
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
      filters.push(keysetCondition(auditLog.createdAt, auditLog.id, cursorDecoded));
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
          .orderBy(...keysetOrderBy(auditLog.createdAt, auditLog.id))
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

  /**
   * B-PROVIDER-2 — read the PROVIDER'S OWN action log (`provider_audit_log`),
   * the table every cross-tenant access already writes to but nothing read.
   * Answers D.37's accountability question ("who on our team accessed customer
   * X, when, why?"). Same keyset-cursor + explicit per-column allowlist as the
   * customers' audit search; the read is itself audited
   * (`provider.self_audit.searched`). The table is bounded by the provider
   * team's own activity (not 30M customer rows), so no SA-4 mandatory date span.
   */
  async selfSearch(
    actor: ProviderActor,
    reason: string,
    query: ProviderSelfAuditQuery,
  ): Promise<ApiList<ProviderSelfAuditItem>> {
    let cursorDecoded: KeysetCursor | null = null;
    if (query.cursor) {
      cursorDecoded = decodeCursorOrThrow(query.cursor);
    }
    const fetchLimit = query.limit + 1;

    const filters: SQL[] = [];
    if (query.affectedOrgId) {
      // GIN-indexed array containment: actions that touched this customer org.
      filters.push(sql`${providerAuditLog.affectedOrgs} @> ARRAY[${query.affectedOrgId}]::uuid[]`);
    }
    if (query.actionType) {
      filters.push(like(providerAuditLog.actionType, `${query.actionType}%`));
    }
    if (query.fromDate) filters.push(gte(providerAuditLog.startedAt, query.fromDate));
    if (query.toDate) filters.push(lte(providerAuditLog.startedAt, query.toDate));
    if (cursorDecoded) {
      filters.push(keysetCondition(providerAuditLog.startedAt, providerAuditLog.id, cursorDecoded));
    }
    const wherePred = filters.length === 0 ? undefined : and(...filters);

    const rows = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        // Explicit per-column allowlist (SA-5) — never select() the whole row.
        return tx
          .select({
            id: providerAuditLog.id,
            providerUserId: providerAuditLog.providerUserId,
            reason: providerAuditLog.reason,
            actionType: providerAuditLog.actionType,
            targetTable: providerAuditLog.targetTable,
            targetRecordId: providerAuditLog.targetRecordId,
            affectedOrgs: providerAuditLog.affectedOrgs,
            ip: providerAuditLog.ip,
            userAgent: providerAuditLog.userAgent,
            startedAt: providerAuditLog.startedAt,
            endedAt: providerAuditLog.endedAt,
            queryCount: providerAuditLog.queryCount,
          })
          .from(providerAuditLog)
          .where(wherePred)
          .orderBy(...keysetOrderBy(providerAuditLog.startedAt, providerAuditLog.id))
          .limit(fetchLimit);
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'provider_audit_log',
        action: 'provider.self_audit.searched',
        metadata: {
          endpoint: 'self-audit',
          filter: {
            affectedOrgId: query.affectedOrgId ?? null,
            actionType: query.actionType ?? null,
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
    const nextCursor = next ? encodeCursor({ createdAt: next.startedAt, id: next.id }) : null;

    return {
      data: page.map((r) => ({
        id: r.id,
        providerUserId: r.providerUserId,
        reason: r.reason,
        actionType: r.actionType,
        targetTable: r.targetTable,
        targetRecordId: r.targetRecordId,
        affectedOrgs: r.affectedOrgs,
        ip: r.ip,
        userAgent: r.userAgent,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        queryCount: r.queryCount,
      })),
      page: {
        limit: query.limit,
        cursor: nextCursor,
        has_more: hasMore,
      },
    };
  }
}
