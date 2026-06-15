import { z } from 'zod';

// Canonical Notification contract (Doc 11 SoT; Phase 3 Slice 7).
//
// Locked RLS: notifications are org+USER scoped — the policy WITH CHECK
// requires user_id = app.user_id, so a user can only ever see/insert
// THEIR OWN. Slice 7 therefore exposes the self read + mark-read API
// only. Notification GENERATION (e.g. on task-assign) + SSE push is
// explicitly a Phase-5 integration (T3.N.1) and is deferred & recorded —
// it cannot be done in an actor's tx under the locked policy anyway.

export const NotificationTypeEnum = z.enum([
  'task_assigned',
  'apartment_status_changed',
  'document_uploaded',
  'signature_received',
  'note_added',
  'share_revoked',
  'mention',
  // Team messaging — a new message arrived in a conversation the user is in.
  'message_received',
]);
export type NotificationType = z.infer<typeof NotificationTypeEnum>;

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  type: NotificationTypeEnum,
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  metadata: z.record(z.unknown()),
  readAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const ListNotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListNotificationsQueryDto = z.infer<typeof ListNotificationsQuery>;
