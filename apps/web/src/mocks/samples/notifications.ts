import { type Notification, type NotificationType } from '@emapp/shared-types';

/**
 * SAMPLE_NOTIFICATIONS — offline fixture for the bell + the /notifications page.
 *
 * Backs the MSW `GET /notifications` (cursor-paginated + `?type=` filter) and
 * `GET /notifications/unread-count` handlers. Authored at SCALE (>25 rows across
 * several types + read-states) so offline mode exercises the whole-set view:
 *   - accumulate-across-pages (the feed pages in 25s, so the set spans >1 page),
 *   - the server-side `?type=` filter (multiple rows per type),
 *   - the TRUE unread count (the bell badge shows the real number, not "5+").
 *
 * NO PII: every `title`/`body` is a document name / apartment number / task
 * title — never an owner name / national_id / phone (the BE emit-site invariant
 * the VM relies on). Schema-parsed by `samples.spec.ts` against NotificationSchema.
 */
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DAY = 86_400_000;
const iso = (msAgo: number): Date => new Date(Date.now() - msAgo);

/** The recurring types the page filter chips narrow by (one chip per type). */
const TYPES: NotificationType[] = [
  'signature_received',
  'task_assigned',
  'document_uploaded',
  'note_added',
  'mention',
  'apartment_status_changed',
  'share_revoked',
];

const HE_TITLE: Record<NotificationType, string> = {
  signature_received: 'חתימה התקבלה — הסכם רוב',
  task_assigned: 'משימה חדשה — מעקב מסמכים',
  document_uploaded: 'מסמך חדש הועלה — נסח טאבו',
  note_added: 'הערה חדשה בפרויקט',
  mention: 'הוזכרת בשיחה',
  apartment_status_changed: 'סטטוס דירה עודכן',
  share_revoked: 'הרשאת שיתוף בוטלה',
  message_received: 'הודעה חדשה',
};

/**
 * 35 rows — spans 2 keyset pages (25 + 10) so "load more" accumulates, and
 * carries >1 row per type so a `?type=` filter returns several matches across
 * pages (proving the server filter is not a 25-row client slice). The first ~14
 * are UNREAD (readAt null) so the true unread total is well above the bell's old
 * "5+" cap — the badge must show the real number.
 */
export const SAMPLE_NOTIFICATIONS: Notification[] = Array.from({ length: 35 }, (_, i) => {
  const type = TYPES[i % TYPES.length]!;
  const unread = i < 14; // 14 unread — exceeds the legacy "5+" page-local cap.
  return {
    id: `dddddddd-dddd-4ddd-8ddd-${String(i + 1).padStart(12, '0')}`,
    organizationId: ORG,
    userId: USER,
    type,
    title: HE_TITLE[type],
    body: i % 3 === 0 ? 'פרויקט מתחם הרצל 12' : null,
    // In-app target — a relative path the adapter's safe-link narrow accepts.
    link: '/projects/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    metadata: {},
    readAt: unread ? null : iso((i + 1) * (DAY / 4)),
    // Newest-first; spread across today / week / earlier for the recency groups.
    createdAt: iso(i * (DAY / 3)),
  } satisfies Notification;
});

/** The TRUE org-wide unread total the dedicated endpoint reports (constant-time
 *  on the BE; here it's just the count of unread rows in the fixture). */
export const SAMPLE_NOTIFICATIONS_UNREAD_COUNT = SAMPLE_NOTIFICATIONS.filter(
  (n) => n.readAt === null,
).length;
