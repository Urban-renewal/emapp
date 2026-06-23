/**
 * Email attachment — V11 B.S7 (D.38 Calendar/ICS).
 * Added so the Calendar email path can include the RFC 5545 .ics
 * blob as a file attachment (clients show "Add to calendar"). The
 * field is optional and pre-existing senders (members invite — D.27)
 * continue to send without attachments unchanged.
 *
 * `contentType` matters for ICS — Resend (and most MTAs) infer based
 * on filename otherwise, and `event.ics` doesn't always trigger the
 * "Add to calendar" UI. Setting `text/calendar; method=REQUEST` makes
 * Gmail/Outlook/Apple Mail recognise the file as an iCalendar invite.
 */
export interface EmailAttachment {
  filename: string;
  content: string; // text content (B.S7 sends UTF-8 ICS; binary would need base64)
  contentType?: string; // e.g., 'text/calendar; method=REQUEST'
}

export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  html?: string;
  text?: string;
  tags?: Record<string, string>;
  /** B.S7 (D.38) — optional attachments. ICS senders set
   *  `[{ filename: 'event.ics', content: <ics-string>,
   *      contentType: 'text/calendar; method=REQUEST' }]`. */
  attachments?: readonly EmailAttachment[];
}

/**
 * Same exactly-once taxonomy as the SMS provider (#509 re-red-team):
 *   - `sent` / `queued` — accepted by the provider.
 *   - `rejected`        — STRUCTURAL decline (provider received the call and
 *                         refused the message: invalid address, suppressed,
 *                         malformed). Provably did NOT go out → DEFINITE.
 *   - `failed`          — TRANSPORT-AMBIGUOUS (5xx / timeout / the call could
 *                         have dispatched before failing). MAY have gone out →
 *                         AMBIGUOUS → parked, never auto-resent.
 *
 * A provider that cannot tell a 5xx from a structural decline (e.g. the current
 * `ResendClient` shape only surfaces `{ message }`, no status code) emits
 * `rejected` for any returned error and relies on the THROW path (caught in the
 * delivery layer → `*_send_failed`) to cover true transport failures. When a
 * provider CAN see the status code, it MUST emit `failed` for 5xx/timeouts.
 */
export interface EmailDeliveryResult {
  id: string;
  status: 'sent' | 'queued' | 'rejected' | 'failed';
  error?: string;
}

export interface IEmailProvider {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
  healthCheck(): Promise<void>;
}
