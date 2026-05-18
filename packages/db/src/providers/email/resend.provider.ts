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

    const { data, error } = await this.client.emails.send({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags,
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
