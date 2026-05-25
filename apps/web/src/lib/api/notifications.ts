/**
 * Notifications API client — Phase 4c S3.
 *
 * Routes (all self-scoped by RLS):
 *   GET  /api/v1/notifications          → { data: Notification[], page }
 *   POST /api/v1/notifications/:id/read → { data: Notification }
 *   POST /api/v1/notifications/read-all → { data: { updated: number } }
 *
 * No DELETE on the wire today — mark-read is the only state
 * transition. The list returns both read + unread; the FE filters /
 * decorates on the VM side.
 */
import { NotificationSchema, type Notification } from '@emapp/shared-types';
import { z } from 'zod';

import { apiClient, isList, isOk } from '../api-client';

import { ApiClientError } from './errors';
import { PageSchema } from './paging';

const NotificationDataSchema = z.object({ data: NotificationSchema });
const ReadAllDataSchema = z.object({ data: z.object({ updated: z.number().int().nonnegative() }) });

export interface NotificationListPage {
  items: Notification[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export async function listNotifications(
  query: { limit?: number; cursor?: string } = {},
): Promise<NotificationListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await apiClient.getList<unknown>(`/notifications${qs ? `?${qs}` : ''}`);
  if (!isList<unknown>(res)) throw new ApiClientError(res.error);
  const items = z.array(NotificationSchema).parse(res.data);
  const page = PageSchema.parse(res.page);
  return { items, page };
}

export async function markNotificationRead(id: string): Promise<Notification> {
  // No Idempotency-Key — mark-read is idempotent server-side via
  // `coalesce(readAt, now())` (notifications.service.ts:85). A double-
  // click sets the same readAt; no duplicate row possible.
  const res = await apiClient.post<unknown>(`/notifications/${id}/read`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return NotificationDataSchema.parse({ data: res.data }).data;
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  const res = await apiClient.post<unknown>(`/notifications/read-all`, {});
  if (!isOk(res)) throw new ApiClientError(res.error);
  return ReadAllDataSchema.parse({ data: res.data }).data;
}
