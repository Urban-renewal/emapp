/**
 * Notification ViewModel — Phase 4c S3.
 *
 * The Wire shape (shared-types/notification.ts) is RLS-self-scoped:
 * every row the BE returns belongs to the current user. There is no
 * cross-user visibility today; notification generation + SSE push is
 * deferred to Phase 5 (T3.N.1).
 *
 * The VM derives:
 *   - `isRead`         : readAt !== null
 *   - `typeLabel`      : locale-bound Hebrew/English caption for the
 *                        7 notification types (exhaustive over the
 *                        locked NotificationTypeEnum)
 *   - `createdRelative`: "לפני X" (formatRelative)
 *   - `link`           : a string OR null — when present, the FE
 *                        treats it as an in-app target (Next Link); a
 *                        leading `http`/`https` is rejected at the
 *                        adapter (defense in depth — open-redirect
 *                        class). The BE today only emits relative
 *                        URLs but the schema is `z.string().nullable()`
 *                        which is unrestricted — the FE narrows.
 */
import type { NotificationType } from '@emapp/shared-types';

/**
 * The ACTION a notification invites — derived purely from its `type`, NOT from
 * any PII. This is what turns the surface from a passive log into a work-surface:
 * the row renders the right primary affordance (open / upload / remind / review /
 * open-thread) and deep-links to the canonical surface that ENFORCES its OWN
 * authz. The notification is never a PII oracle (G-RT): tapping an action lands
 * on `link`, which re-checks the actor's permissions server-side.
 *
 *   - `upload`     : a document was requested/chased here → "העלה כאן" (the
 *                    document detail is where the file is added).
 *   - `remind`     : a signature/owner is stuck → "שלח תזכורת" (open the
 *                    request/document to chase from the canonical send seam).
 *   - `review`     : a status/extraction changed and wants a human glance.
 *   - `open-thread`: a message/mention → open the conversation.
 *   - `open`       : the generic "go look at the entity" fallback.
 */
export type NotificationActionKind = 'open' | 'upload' | 'remind' | 'review' | 'open-thread';

/**
 * Recency bucket for the grouped (NON-flat) list — derived from `createdAt`
 * against Asia/Jerusalem civil days (CLAUDE.md "display Asia/Jerusalem"). The
 * list groups rows under these so a hundred notifications stay scannable
 * (situation-picture, NOT a flat wall): newest-relevant first.
 */
export type NotificationRecencyBucket = 'today' | 'week' | 'earlier';

export interface NotificationViewModel {
  id: string;
  type: NotificationType;
  typeLabel: string;
  title: string;
  body: string | null;
  /** In-app target. `null` if the BE didn't supply one OR if the
   *  supplied value didn't match the relative-path safelist. */
  link: string | null;
  isRead: boolean;
  createdRelative: string;
  createdAtIso: string;
  /** The primary action this notification invites — derived from `type` only
   *  (never from PII). Drives the row's action button + the bell's affordance. */
  actionKind: NotificationActionKind;
  /** Today / this-week / earlier — for the grouped, attention-first list. */
  recencyBucket: NotificationRecencyBucket;
}
