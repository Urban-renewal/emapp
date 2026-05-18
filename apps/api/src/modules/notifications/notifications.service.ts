import { notifications, withTenant } from '@emapp/db';
import type { Notification } from '@emapp/shared-types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
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
  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<NotificationListPage> {
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
              lt(notifications.createdAt, new Date(cur.c)),
              and(eq(notifications.createdAt, new Date(cur.c)), lt(notifications.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(notifications)
          .where(keyset)
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
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
