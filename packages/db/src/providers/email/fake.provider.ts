import type { IEmailProvider, EmailMessage, EmailDeliveryResult } from './email.interface';

export class FakeEmailProvider implements IEmailProvider {
  public sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.sent.push(message);
    return { id: `fake-${this.sent.length}`, status: 'sent' };
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.sent = [];
  }

  lastSent(): EmailMessage | undefined {
    return this.sent.at(-1);
  }
}
