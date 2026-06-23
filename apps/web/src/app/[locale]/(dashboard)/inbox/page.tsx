import { InboxListClient } from './inbox-list.client';

/**
 * Approval Inbox page (Autonomous Master Plan, Phase 1) — route `/[locale]/inbox`.
 *
 * The autonomy engine's human-confirm surface: the user reviews the system's
 * PENDING PROPOSALS and confirms each with one click. A thin Server Component
 * shell mounts the client island (the manager-only data + the one-click
 * approve/reject mutations live in `InboxListClient`). The dashboard layout
 * already mounts `<ToastProvider>`, so the client surface can fire action toasts.
 */
export default function InboxPage() {
  return <InboxListClient />;
}
