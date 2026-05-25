/**
 * Wire → ViewModel adapter for Notification (Phase 4c S3).
 *
 * Notification types are a locked enum (shared-types). The label set
 * is exhaustive — a future enum addition that forgets a label fails
 * CI via the spec's keys-equality check.
 *
 * `link` is narrowed at the adapter to defend against open-redirect:
 * the BE today emits relative paths only, but the wire schema is
 * `z.string()` (unrestricted). A future BE bug that puts an absolute
 * URL into `link` would otherwise let an attacker craft a
 * notification that bounces the user to an off-domain page when
 * clicked. We accept only relative paths starting with `/` (and
 * additionally reject `//` protocol-relative URLs).
 */
import type { Notification, NotificationType } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { DisplayLocale } from '@/lib/locale';
import type { NotificationViewModel } from '@/models/notification.vm';

const TYPE_LABELS_HE: Record<NotificationType, string> = {
  task_assigned: 'משימה חדשה',
  apartment_status_changed: 'סטטוס דירה עודכן',
  document_uploaded: 'מסמך חדש',
  signature_received: 'חתימה התקבלה',
  note_added: 'הערה חדשה',
  share_revoked: 'הרשאת שיתוף בוטלה',
  mention: 'הוזכרת',
};

const TYPE_LABELS_EN: Record<NotificationType, string> = {
  task_assigned: 'New task',
  apartment_status_changed: 'Apartment status updated',
  document_uploaded: 'New document',
  signature_received: 'Signature received',
  note_added: 'New note',
  share_revoked: 'Share permission revoked',
  mention: 'You were mentioned',
};

/** Accept only relative in-app paths. Protocol-relative `//evil.com`
 *  is rejected explicitly because some routers normalize it to an
 *  absolute redirect. Same posture as `packages/shared-types/safe-url.ts`. */
function safeInAppLink(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

export function toNotificationViewModel(
  n: Notification,
  locale: DisplayLocale = 'he',
): NotificationViewModel {
  const typeLabels = locale === 'en' ? TYPE_LABELS_EN : TYPE_LABELS_HE;
  return {
    id: n.id,
    type: n.type,
    typeLabel: typeLabels[n.type],
    title: n.title,
    body: n.body,
    link: safeInAppLink(n.link),
    isRead: n.readAt !== null,
    createdRelative: formatRelative(n.createdAt, locale),
    createdAtIso: n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt),
  };
}

export function toNotificationViewModels(
  items: Notification[],
  locale: DisplayLocale = 'he',
): NotificationViewModel[] {
  return items.map((n) => toNotificationViewModel(n, locale));
}

export const NOTIFICATION_TYPE_LABELS_HE = TYPE_LABELS_HE;
export const NOTIFICATION_TYPE_LABELS_EN = TYPE_LABELS_EN;
