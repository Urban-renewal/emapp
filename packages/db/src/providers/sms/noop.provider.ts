import type { ISMSProvider, SMSDeliveryResult } from './sms.interface';

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return '****' + phone.slice(-4);
}

export class NoopSMSProvider implements ISMSProvider {
  async send(to: string, body: string): Promise<SMSDeliveryResult> {
    process.stderr.write(
      `[NoopSMSProvider] SMS not sent — noop active. to=${maskPhone(to)} body=${body.slice(0, 30)}\n`,
    );
    return { id: `noop-${Date.now()}`, status: 'sent' };
  }

  async healthCheck(): Promise<void> {}
}
