import type { IEmailProvider, EmailMessage, EmailDeliveryResult } from './email.interface';

interface ResendClient {
  emails: {
    send(opts: {
      from: string;
      to: string;
      subject: string;
      html?: string;
      text?: string;
      tags?: Array<{ name: string; value: string }>;
      // Resend SDK shape: each attachment is `{ filename, content }`
      // where content is base64 string OR Buffer. We pass plain UTF-8
      // text encoded to base64 (Resend handles both, but base64 is
      // safer against binary-clean issues for non-ASCII content like
      // Hebrew ICS payloads).
      attachments?: Array<{ filename: string; content: string; contentType?: string }>;
    }): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
  };
}

export class ResendEmailProvider implements IEmailProvider {
  constructor(
    private readonly client: ResendClient,
    private readonly defaultFrom: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    const tags = message.tags
      ? Object.entries(message.tags).map(([name, value]) => ({ name, value }))
      : undefined;

    // V11 B.S7 — pass attachments through to Resend SDK. Content is
    // base64-encoded so multibyte UTF-8 payloads (Hebrew ICS) survive
    // transit cleanly. contentType is forwarded so the recipient's
    // mail client recognises the .ics file as an iCalendar invite.
    const attachments = message.attachments
      ? message.attachments.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content, 'utf-8').toString('base64'),
          contentType: a.contentType,
        }))
      : undefined;

    const { data, error } = await this.client.emails.send({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags,
      attachments,
    });

    if (error) {
      return { id: 'error', status: 'rejected', error: error.message };
    }
    return { id: data?.id ?? 'unknown', status: 'sent' };
  }

  async healthCheck(): Promise<void> {
    // No-op: Resend has no dedicated health endpoint; errors surface on first send
  }
}
