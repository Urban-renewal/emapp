import { createHmac, randomBytes } from 'crypto';

import { sql } from 'drizzle-orm';

import type { Database } from '../client';
import { env } from '../env';

function requirePiiKeys(): { encKey: string; hashKey: string } {
  const encKey = env.PII_ENCRYPTION_KEY;
  const hashKey = env.PII_HASH_KEY;
  if (!encKey || !hashKey) {
    throw new Error('PII_ENCRYPTION_KEY and PII_HASH_KEY are required for owner operations');
  }
  return { encKey, hashKey };
}

export function hashField(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export async function encryptField(db: Database, value: string, encKey: string): Promise<Buffer> {
  const result = await db.execute<{ enc: Buffer }>(
    sql`SELECT pgp_sym_encrypt(${value}, ${encKey}) AS enc`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('pgp_sym_encrypt returned no result');
  return row.enc;
}

export async function decryptField(
  db: Database,
  encrypted: Buffer,
  encKey: string,
): Promise<string> {
  const result = await db.execute<{ dec: string }>(
    sql`SELECT pgp_sym_decrypt(${encrypted}, ${encKey}) AS dec`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('pgp_sym_decrypt returned no result');
  return row.dec;
}

export interface PiiFields {
  nationalId: string;
  phone?: string;
}

export interface EncryptedPiiFields {
  nationalIdEncrypted: Buffer;
  nationalIdHash: string;
  phoneEncrypted: Buffer | null;
  phoneHash: string | null;
}

export async function encryptOwnerPii(db: Database, pii: PiiFields): Promise<EncryptedPiiFields> {
  const { encKey, hashKey } = requirePiiKeys();

  const nationalIdEncrypted = await encryptField(db, pii.nationalId, encKey);
  const nationalIdHash = hashField(pii.nationalId, hashKey);

  let phoneEncrypted: Buffer | null = null;
  let phoneHash: string | null = null;
  if (pii.phone) {
    phoneEncrypted = await encryptField(db, pii.phone, encKey);
    phoneHash = hashField(pii.phone, hashKey);
  }

  return { nationalIdEncrypted, nationalIdHash, phoneEncrypted, phoneHash };
}

export async function decryptOwnerPii(
  db: Database,
  encrypted: { nationalIdEncrypted: Buffer; phoneEncrypted: Buffer | null },
): Promise<{ nationalId: string; phone: string | null }> {
  const { encKey } = requirePiiKeys();

  const nationalId = await decryptField(db, encrypted.nationalIdEncrypted, encKey);
  const phone = encrypted.phoneEncrypted
    ? await decryptField(db, encrypted.phoneEncrypted, encKey)
    : null;

  return { nationalId, phone };
}

void randomBytes; // imported for future signing use
