import type { Database } from '../client';

import { decryptField, encryptField, requirePiiKeys } from './owners';

/**
 * W-4.1 — the ONE canonical encrypt/mask path for external-share RECIPIENT
 * contact PII (email + phone). It reuses the SAME pgcrypto seam owners use
 * (`encryptField`/`decryptField` + `requirePiiKeys`, key PII_ENCRYPTION_KEY) —
 * NOT a second crypto implementation. The service NEVER hand-rolls
 * encryption/masking; it calls these so there is a single source of truth for
 * how recipient PII is protected and projected.
 *
 * Invariants:
 *   - The raw email/phone is encrypted at rest (bytea) and is NEVER returned to
 *     a client — only `maskEmail`/`maskPhone` projections cross the wire.
 *   - Masking happens AFTER decrypt, on the plaintext; the ciphertext is never
 *     exposed either.
 */

/** Encrypt a recipient email/phone (or pass through null). One pgcrypto
 *  round-trip per non-null value, via the shared owners seam. */
export async function encryptRecipientField(
  db: Database,
  value: string | null | undefined,
): Promise<Buffer | null> {
  if (value === null || value === undefined || value === '') return null;
  const { encKey } = requirePiiKeys();
  return encryptField(db, value, encKey);
}

/** Decrypt a recipient ciphertext (or null). Internal to the masking path —
 *  callers should prefer `maskRecipientEmail`/`maskRecipientPhone`. */
export async function decryptRecipientField(
  db: Database,
  encrypted: Buffer | null | undefined,
): Promise<string | null> {
  if (!encrypted) return null;
  const { encKey } = requirePiiKeys();
  return decryptField(db, encrypted, encKey);
}

/** `name@domain` → `na***@domain`. The manager already knows the address; we
 *  just never echo the raw value into wire artifacts (screenshot-safe). Pure. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.length <= 2 ? (local[0] ?? '') : local.slice(0, 2);
  return `${head}***@${domain}`;
}

/** A phone → keep only the last 2 digits: `••••••12`. Pure. Non-digits are
 *  stripped for the count so formatting can't leak length precisely. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 2) return '••••••';
  return '••••••' + digits.slice(-2);
}

/** Decrypt + mask a recipient email ciphertext for the wire. Null → null. */
export async function maskRecipientEmail(
  db: Database,
  encrypted: Buffer | null | undefined,
): Promise<string | null> {
  const plain = await decryptRecipientField(db, encrypted);
  return plain === null ? null : maskEmail(plain);
}

/** Decrypt + mask a recipient phone ciphertext for the wire. Null → null. */
export async function maskRecipientPhone(
  db: Database,
  encrypted: Buffer | null | undefined,
): Promise<string | null> {
  const plain = await decryptRecipientField(db, encrypted);
  return plain === null ? null : maskPhone(plain);
}
