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
}
