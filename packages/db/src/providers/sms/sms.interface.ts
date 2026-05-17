export interface SMSDeliveryResult {
  id: string;
  status: 'sent' | 'queued' | 'rejected';
  error?: string;
}

export interface ISMSProvider {
  send(to: string, body: string): Promise<SMSDeliveryResult>;
  healthCheck(): Promise<void>;
}
