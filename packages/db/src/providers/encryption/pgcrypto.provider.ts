import { createHmac } from 'crypto';

import { sql } from 'drizzle-orm';

import { db } from '../../client';

import type { IEncryptionService } from './encryption.interface';

export class PgcryptoEncryptionService implements IEncryptionService {
  constructor(private readonly hashKey: Buffer) {}

  hash(plaintext: string): string {
    return createHmac('sha256', this.hashKey).update(plaintext, 'utf8').digest('hex');
  }

  async healthCheck(): Promise<void> {
    const result = await db.execute<{ ok: boolean }>(sql`
      SELECT pgp_sym_decrypt(
        pgp_sym_encrypt('test', 'health-check-key'),
        'health-check-key'
      ) = 'test' AS ok
    `);
    const row = result.rows[0];
    if (!row?.ok) throw new Error('pgcrypto health check failed');
  }
}
