import { notifications, withTenant } from '@emapp/db';
import type { Notification, NotificationType } from '@emapp/shared-types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface NotificationListPage {
  data: Notification[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

function toNotification(r: typeof notifications.$inferSelect): Notification {
  return {
    id: r.id,
    organizationId: r.orgId,
    userId: r.userId,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link,
    metadata: r.metadata,
    readAt: r.readAt,
    createdAt: r.createdAt,
  };
}

/**
 * Notifications domain service (Phase 3 Slice 7) — SELF-scoped only.
 *
 * The locked notifications RLS policy (org_id = app.organization_id AND
 * user_id = app.user_id) means every read/write here is automatically
 * the caller's own — no extra service-side user filter is needed or
 * possible to widen. Any org role can read/mark THEIR OWN notifications.
 * Generation (task-assign etc.) + SSE is Phase 5 (T3.N.1) — deferred.
 */
@Injectable()
export class NotificationsService {
  /**
   * Audit M2-perf fix — dedicated unread-count endpoint. The Manager
   * dashboard bell polls this every ~30s; without a single-shot count,
   * the FE has been hitting GET /api/v1/notifications?limit=100 and
   * counting client-side (full row payload over the wire + RLS scan).
   * This uses the partial index `idx_notifications_user_unread`
   * (read_at IS NULL) for a constant-time count.
   */
  async unreadCount(user: AccessTokenPayload): Promise<{ count: number }> {
    const result = await withTenant(
      user.orgId,
      async (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .where(isNull(notifications.readAt)),
      { userId: user.sub },
    );
    return { count: result[0]?.count ?? 0 };
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string; type?: NotificationType },
  ): Promise<NotificationListPage> {
    const { limit, type } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset: SQL | undefined = cur
          ? keysetCondition(notifications.createdAt, notifications.id, cur)
          : undefined;
        // The optional TYPE filter narrows the WHOLE feed server-side (composes
        // with the keyset cursor via AND), so a filtered "load more" walks every
        // matching row org-wide — not the 25-row page-local client filter. RLS
        // still scopes to the caller's own rows; this only narrows by type.
        const typeFilter: SQL | undefined = type ? eq(notifications.type, type) : undefined;
        const where = and(keyset, typeFilter);
        return tx
          .select()
          .from(notifications)
          .where(where)
          .orderBy(...keysetOrderBy(notifications.createdAt, notifications.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toNotification),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  // RLS guarantees only the caller's own row is visible/updatable.
  async markRead(user: AccessTokenPayload, id: string): Promise<Notification> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx
          .update(notifications)
          .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
          .where(eq(notifications.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        return toNotification(row);
      },
      { userId: user.sub },
    );
  }

  async markAllRead(user: AccessTokenPayload): Promise<{ updated: number }> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const rows = await tx
          .update(notifications)
          .set({ readAt: sql`now()` })
          .where(isNull(notifications.readAt))
          .returning({ id: notifications.id });
        return { updated: rows.length };
      },
      { userId: user.sub },
    );
  }
}
