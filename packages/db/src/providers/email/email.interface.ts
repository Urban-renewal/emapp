export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  html?: string;
  text?: string;
  tags?: Record<string, string>;
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
