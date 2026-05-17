import { createHmac } from 'crypto';

import type { IEncryptionService } from './encryption.interface';

export class FakeEncryptionService implements IEncryptionService {
  private readonly key = Buffer.from('fake-test-key-32-bytes-padding!!');

  hash(plaintext: string): string {
    return createHmac('sha256', this.key).update(plaintext).digest('hex');
  }

  async healthCheck(): Promise<void> {}
}
