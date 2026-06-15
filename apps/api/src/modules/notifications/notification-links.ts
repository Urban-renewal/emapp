/**
 * Deep-link builder for in-app notifications (the `notifications.link` column).
 *
 * A notification's `link` is a FRONTEND ROUTE PATH (no locale prefix — the FE
 * `<Link>` adds `/he` | `/en`). Centralised here so every emit site builds the
 * SAME shape, the FE↔BE route contract lives in ONE place, and a route rename
 * is a single edit. Pure + dependency-free → unit-testable; the notification
 * producer stays unaware of route shapes.
 *
 * Every target route EXISTS in apps/web (verified against the (dashboard)
 * route tree) — a notification must never deep-link to a 404. All ids are
 * server-owned UUIDs (never user free-text), so the path needs no escaping.
 */
export const notificationLink = {
  /** Document detail — shows the file + its signature status. */
  document: (documentId: string): string => `/documents/${documentId}`,
  /** Apartment detail — ownerships, status, notes. */
  apartment: (apartmentId: string): string => `/apartments/${apartmentId}`,
  /** Note detail. */
  note: (noteId: string): string => `/notes/${noteId}`,
  /** Task detail. */
  task: (taskId: string): string => `/tasks/${taskId}`,
  /** A project's contractor-shares screen (share grant/revoke surface). */
  projectShares: (projectId: string): string => `/projects/${projectId}/shares`,
  /** A team-messaging conversation thread (the /messages ?c= deep-link). */
  message: (conversationId: string): string => `/messages?c=${conversationId}`,
} as const;
