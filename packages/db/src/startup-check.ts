import { sql } from 'drizzle-orm';

import { db } from './client';
import { env } from './env';

/**
 * P1.10 — fail-fast encryption verification, called from the API main.ts
 * AFTER boot and BEFORE serving requests.
 *
 * Verifies, against the real database + pgcrypto, that:
 *   1. pgp_sym_encrypt → pgp_sym_decrypt round-trips with PII_ENCRYPTION_KEY
 *   2. HMAC-SHA256 with PII_HASH_KEY is deterministic (same input → same output)
 *
 * If either invariant is broken (missing/incorrect keys, pgcrypto not installed),
 * this throws and the app must refuse to start. Loud failure beats silently
 * writing unrecoverable or unsearchable PII.
 */
export async function verifyEncryptionStartup(): Promise<void> {
  const probe = 'startup-encryption-probe';

  const roundTrip = await db.execute<{ decrypted: string }>(
    sql`SELECT pgp_sym_decrypt(
          pgp_sym_encrypt(${probe}, ${env.PII_ENCRYPTION_KEY}),
          ${env.PII_ENCRYPTION_KEY}
        ) AS decrypted`,
  );
  const decrypted = roundTrip.rows[0]?.decrypted;
  if (decrypted !== probe) {
    throw new Error(
      'verifyEncryptionStartup: pgcrypto round-trip failed — PII_ENCRYPTION_KEY is missing or invalid, or pgcrypto is not installed',
    );
  }

  const hmac = await db.execute<{ a: string; b: string }>(
    sql`SELECT
          encode(hmac(${probe}::bytea, ${env.PII_HASH_KEY}::bytea, 'sha256'), 'hex') AS a,
          encode(hmac(${probe}::bytea, ${env.PII_HASH_KEY}::bytea, 'sha256'), 'hex') AS b`,
  );
  const { a, b } = hmac.rows[0] ?? { a: '', b: '' };
  if (!a || a !== b) {
    throw new Error(
      'verifyEncryptionStartup: HMAC is not deterministic — PII_HASH_KEY is missing or invalid',
    );
  }
}
