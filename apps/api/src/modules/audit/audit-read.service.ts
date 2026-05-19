import { auditLog, withTenant } from '@emapp/db';
import type { AuditEntry } from '@emapp/shared-types';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface AuditListPage {
  data: AuditEntry[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * Audit-Read (Phase 3 Slice 8). APPEND-ONLY table; this exposes a
 * MANAGER-ONLY org-scoped read (audit_log RLS = org isolation). The
 * before/after diffs, ip and user_agent are deliberately NOT projected
 * (they can carry sensitive context) — only who/what/target/when.
 */
@Injectable()
export class AuditReadService {
  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<AuditListPage> {
    if (user.role !== 'manager') throw FORBIDDEN;
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset: SQL | undefined = cur
          ? or(
              lt(auditLog.createdAt, new Date(cur.c)),
              and(eq(auditLog.createdAt, new Date(cur.c)), lt(auditLog.id, cur.i)),
            )
          : undefined;
        return tx
          .select({
            id: auditLog.id,
            orgId: auditLog.orgId,
            actorId: auditLog.actorId,
            actorType: auditLog.actorType,
            actorEmail: auditLog.actorEmail,
            action: auditLog.action,
            targetTable: auditLog.targetTable,
            targetId: auditLog.targetId,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(keyset)
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => ({
        id: r.id,
        organizationId: r.orgId,
        actorId: r.actorId,
        actorType: r.actorType as AuditEntry['actorType'],
        actorEmail: r.actorEmail,
        action: r.action,
        targetTable: r.targetTable,
        targetId: r.targetId,
        createdAt: r.createdAt,
      })),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
        has_more: hasMore,
      },
    };
  }
}
