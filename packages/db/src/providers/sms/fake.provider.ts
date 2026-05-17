import type { ISMSProvider, SMSDeliveryResult } from './sms.interface';

export class FakeSMSProvider implements ISMSProvider {
  public sent: Array<{ to: string; body: string }> = [];

  async send(to: string, body: string): Promise<SMSDeliveryResult> {
    this.sent.push({ to, body });
    return { id: `fake-${this.sent.length}`, status: 'sent' };
  }

  async healthCheck(): Promise<void> {}

  reset(): void {
    this.sent = [];
  }

  lastSent(): { to: string; body: string } | undefined {
    return this.sent.at(-1);
  }
}
