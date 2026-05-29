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

export interface EmailDeliveryResult {
  id: string;
  status: 'sent' | 'queued' | 'rejected';
  error?: string;
}

export interface IEmailProvider {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
  healthCheck(): Promise<void>;
}
