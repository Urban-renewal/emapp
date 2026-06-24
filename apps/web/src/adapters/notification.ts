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
import type {
  NotificationActionKind,
  NotificationRecencyBucket,
  NotificationViewModel,
} from '@/models/notification.vm';

const TYPE_LABELS_HE: Record<NotificationType, string> = {
  task_assigned: 'משימה חדשה',
  apartment_status_changed: 'סטטוס דירה עודכן',
  document_uploaded: 'מסמך חדש',
  signature_received: 'חתימה התקבלה',
  note_added: 'הערה חדשה',
  share_revoked: 'הרשאת שיתוף בוטלה',
  mention: 'הוזכרת',
  message_received: 'הודעה חדשה',
};

const TYPE_LABELS_EN: Record<NotificationType, string> = {
  task_assigned: 'New task',
  apartment_status_changed: 'Apartment status updated',
  document_uploaded: 'New document',
  signature_received: 'Signature received',
  note_added: 'New note',
  share_revoked: 'Share permission revoked',
  mention: 'You were mentioned',
  message_received: 'New message',
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

/**
 * The primary action each notification TYPE invites — the heart of the
 * passive-log→work-surface change. Derived from `type` ALONE (never from PII or
 * metadata), exhaustive over the locked `NotificationTypeEnum` (a future enum
 * addition that forgets a mapping fails the adapter spec's keys-equality check).
 *
 *   - document_uploaded → `upload`: a document landed/was requested here; the
 *     next human step on the document surface is to add/replace the file.
 *   - signature_received → `remind`: a signature event — open the request/doc to
 *     chase remaining signers from the canonical send seam (never a bare "open").
 *   - task_assigned → `review`: a task needs a human to action it.
 *   - apartment_status_changed → `review`: a status moved; glance + confirm.
 *   - note_added → `review`: a note wants reading.
 *   - mention / message_received → `open-thread`: jump into the conversation.
 *   - share_revoked → `open`: an access change to inspect (no chase action).
 */
const TYPE_TO_ACTION: Record<NotificationType, NotificationActionKind> = {
  document_uploaded: 'upload',
  signature_received: 'remind',
  task_assigned: 'review',
  apartment_status_changed: 'review',
  note_added: 'review',
  mention: 'open-thread',
  message_received: 'open-thread',
  share_revoked: 'open',
};

/**
 * Asia/Jerusalem civil-day key (`YYYY-MM-DD`) for an instant — the SAME tz the
 * rest of the product displays in (CLAUDE.md "store UTC, display Asia/Jerusalem"),
 * so the recency grouping agrees with the row's "לפני X" relative time. `en-CA`
 * yields ISO-ordered parts regardless of the viewer locale.
 */
const CIVIL_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function civilDayMs(at: Date): number {
  const [y, m, d] = CIVIL_DAY_FMT.format(at).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/**
 * Bucket a notification by recency for the grouped list — `today`, `week`
 * (1–6 Israel-civil-days ago), or `earlier`. Whole-day arithmetic in Israel
 * civil time (immune to the runtime tz + DST), mirroring `formatRelative`'s
 * day-level logic so the section a row sits in matches its relative caption.
 * `now` is injectable for deterministic tests.
 */
export function notificationRecencyBucket(
  createdAt: Date,
  now: Date = new Date(),
): NotificationRecencyBucket {
  const deltaDays = Math.round((civilDayMs(now) - civilDayMs(createdAt)) / 86_400_000);
  if (deltaDays <= 0) return 'today';
  if (deltaDays < 7) return 'week';
  return 'earlier';
}

export function toNotificationViewModel(
  n: Notification,
  locale: DisplayLocale = 'he',
  now: Date = new Date(),
): NotificationViewModel {
  const typeLabels = locale === 'en' ? TYPE_LABELS_EN : TYPE_LABELS_HE;
  const createdAt = n.createdAt instanceof Date ? n.createdAt : new Date(n.createdAt);
  // PII boundary (G-RT): the VM carries ONLY the BE-supplied `title`/`body`
  // (guaranteed org-visible, non-PII at every emit site — document name /
  // apartment number / task title, never owner name / national_id / phone) plus
  // the type-derived label/action. We deliberately DO NOT read `n.metadata` —
  // the notification is not a PII oracle; any sensitive value lives behind the
  // `link` target's own authz, never in the rendered row.
  return {
    id: n.id,
    type: n.type,
    typeLabel: typeLabels[n.type],
    title: n.title,
    body: n.body,
    link: safeInAppLink(n.link),
    isRead: n.readAt !== null,
    createdRelative: formatRelative(createdAt, locale, now),
    createdAtIso: createdAt.toISOString(),
    actionKind: TYPE_TO_ACTION[n.type],
    recencyBucket: notificationRecencyBucket(createdAt, now),
  };
}

export function toNotificationViewModels(
  items: Notification[],
  locale: DisplayLocale = 'he',
  now: Date = new Date(),
): NotificationViewModel[] {
  return items.map((n) => toNotificationViewModel(n, locale, now));
}

export const NOTIFICATION_TYPE_TO_ACTION = TYPE_TO_ACTION;

export const NOTIFICATION_TYPE_LABELS_HE = TYPE_LABELS_HE;
export const NOTIFICATION_TYPE_LABELS_EN = TYPE_LABELS_EN;
