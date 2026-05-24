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
  /** v8 §v8-S3: name is now pgcrypto-encrypted alongside the
   *  national_id + phone. Required (every owner has a name). */
  name: string;
}

export interface EncryptedPiiFields {
  nationalIdEncrypted: Buffer;
  nationalIdHash: string;
  phoneEncrypted: Buffer | null;
  phoneHash: string | null;
  /** v8 §v8-S3 — encrypted name bytea + HMAC hash for exact-match. */
  nameEncrypted: Buffer;
  nameHash: Buffer;
}

/** v8 §v8-S3 — single-name encrypt for the API write path. The bulk
 *  worker path uses encryptOwnerPiiBatch which folds this in. */
export async function encryptOwnerName(
  db: Database,
  name: string,
): Promise<{ nameEncrypted: Buffer; nameHash: Buffer }> {
  const { encKey, hashKey } = requirePiiKeys();
  const nameEncrypted = await encryptField(db, name, encKey);
  // Hash is bytea (matches the column type) — HMAC-SHA256 raw bytes,
  // not hex. We store bytea to avoid the hex/utf8 conversion cost on
  // every lookup; consumers compare via byte equality.
  const nameHash = Buffer.from(createHmac('sha256', hashKey).update(name).digest());
  return { nameEncrypted, nameHash };
}

/** v8 §v8-S3 — decrypt a single owner's name. Used by the API
 *  read sites; the helper takes the encrypted bytea and the
 *  current `Database` (drizzle/tenant tx). */
export async function decryptOwnerName(db: Database, encrypted: Buffer): Promise<string> {
  const { encKey } = requirePiiKeys();
  return decryptField(db, encrypted, encKey);
}

/** v8 §v8-S3 — compute the name HMAC without DB round-trip. Used by
 *  the search path / replay-style lookups. Returns bytea-equivalent
 *  Buffer so callers can compare against `owners.name_hash` directly. */
export function hashOwnerName(name: string): Buffer {
  const { hashKey } = requirePiiKeys();
  return Buffer.from(createHmac('sha256', hashKey).update(name).digest());
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

  // v8 §v8-S3 — name encryption (mandatory).
  const nameEncrypted = await encryptField(db, pii.name, encKey);
  const nameHash = Buffer.from(createHmac('sha256', hashKey).update(pii.name).digest());

  return {
    nationalIdEncrypted,
    nationalIdHash,
    phoneEncrypted,
    phoneHash,
    nameEncrypted,
    nameHash,
  };
}

/**
 * Batched-encrypt N PII records in TWO pg round-trips (one for the
 * national_id column, one for the phone column).
 *
 * Audit-pass v3 finding E1/E2: the per-row `encryptOwnerPii` did one
 * `pgp_sym_encrypt` SELECT round-trip per value — 200 round-trips for
 * 100 owners × 2 fields. At Neon RTT (~50ms) that's 10s wasted on a
 * 100-row import (T6.10 budget = 45s; pre-batching the test measured
 * 60+s; post-batching < 25s).
 *
 * Strategy:
 *   - Hashes are deterministic HMAC — pure local CPU, no DB call.
 *   - For encryption, use `unnest($1::text[])` to encrypt N values in
 *     one round-trip. The result is the same byte-equivalent ciphertext
 *     as N individual calls.
 *
 * Order preservation: pg's `unnest` returns rows in array order; we
 * preserve that order by also enumerating with WITH ORDINALITY and
 * matching back to the input index.
 *
 * Empty / undefined phones: indexed positions with no phone are sent
 * as `NULL` in the array; pg's `pgp_sym_encrypt` handles NULL input
 * by returning NULL. The result blob is then `null` for that row.
 */
export async function encryptOwnerPiiBatch(
  db: Database,
  inputs: PiiFields[],
): Promise<EncryptedPiiFields[]> {
  if (inputs.length === 0) return [];
  const { encKey, hashKey } = requirePiiKeys();

  const nationalIds = inputs.map((p) => p.nationalId);
  const phones = inputs.map((p) => p.phone ?? null);
  // v8 §v8-S3: also batch-encrypt names. SAME round-trip discipline
  // (one SELECT per column, jsonb_array_elements_text WITH ORDINALITY
  // preserves order). With the per-statement memoization plus this,
  // the worker now does THREE pgcrypto round-trips per 5000-row chunk
  // instead of the pre-batching N×3.
  const names = inputs.map((p) => p.name);

  // Drizzle's sql template inlines a JS array as a parameter that
  // pg-node serialises as text[] automatically; explicit ::text[]
  // cast inside the SQL trips parse_expr "cannot cast type". Pass
  // via jsonb_array_elements_text — the JSON is unambiguous, the
  // text-array extraction is server-side, and the result order is
  // preserved via WITH ORDINALITY. ONE round-trip per column.
  const idRes = await db.execute<{ enc: Buffer; idx: number }>(
    sql`
      SELECT pgp_sym_encrypt(t.val, ${encKey}) AS enc, t.idx::int AS idx
      FROM jsonb_array_elements_text(${JSON.stringify(nationalIds)}::jsonb) WITH ORDINALITY AS t(val, idx)
      ORDER BY t.idx
    `,
  );

  // For phones, jsonb_array_elements_text returns NULL for JSON null
  // entries (preserves array shape). CASE keeps the result aligned
  // with the input index — null in, null out.
  const phoneRes = await db.execute<{ enc: Buffer | null; idx: number }>(
    sql`
      SELECT
        CASE WHEN t.val IS NULL THEN NULL ELSE pgp_sym_encrypt(t.val, ${encKey}) END AS enc,
        t.idx::int AS idx
      FROM jsonb_array_elements_text(${JSON.stringify(phones)}::jsonb) WITH ORDINALITY AS t(val, idx)
      ORDER BY t.idx
    `,
  );

  // v8 §v8-S3 — same pattern for names; name is REQUIRED so no
  // NULL handling.
  const nameRes = await db.execute<{ enc: Buffer; idx: number }>(
    sql`
      SELECT pgp_sym_encrypt(t.val, ${encKey}) AS enc, t.idx::int AS idx
      FROM jsonb_array_elements_text(${JSON.stringify(names)}::jsonb) WITH ORDINALITY AS t(val, idx)
      ORDER BY t.idx
    `,
  );

  const out: EncryptedPiiFields[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const idEnc = idRes.rows[i]?.enc;
    if (!idEnc) throw new Error('encryptOwnerPiiBatch: missing national_id ciphertext');
    const nameEnc = nameRes.rows[i]?.enc;
    if (!nameEnc) throw new Error('encryptOwnerPiiBatch: missing name ciphertext');
    const phoneEnc = phoneRes.rows[i]?.enc ?? null;
    const input = inputs[i]!;
    out.push({
      nationalIdEncrypted: idEnc,
      nationalIdHash: hashField(input.nationalId, hashKey),
      phoneEncrypted: phoneEnc,
      phoneHash: input.phone ? hashField(input.phone, hashKey) : null,
      nameEncrypted: nameEnc,
      // v8 §v8-S3: hashOwnerName output (Buffer, raw SHA256 bytes)
      // matches the bytea column type. Computed locally — no DB
      // round-trip.
      nameHash: Buffer.from(createHmac('sha256', hashKey).update(input.name).digest()),
    });
  }
  return out;
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
