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

/**
 * V11 B.S10-followup — batched decrypt for the export composer hot path
 * (and any future bulk-read site).
 *
 * Mirrors the `encryptOwnerPiiBatch` discipline: ONE round-trip per
 * column instead of N. At ~50ms Neon RTT, 1000 owners drop from
 * ~5s (parallel `Promise.all`, capped by the 10-conn pool) to
 * ~150ms (THREE round-trips total: name + national_id + phone).
 *
 * Strategy: pg's `unnest()` on a bytea[] preserves array order; we
 * pair it with `WITH ORDINALITY` so the result rows can be reassembled
 * back to the input index. Empty input → empty array (no round-trip).
 *
 * Phone is optional — input rows pass `phoneEncrypted: null` for
 * phone-less owners and the CASE expression returns NULL aligned with
 * the input position (same pattern as the encrypt batch helper's
 * NULL handling).
 */
export interface EncryptedOwnerRow {
  /** Position-preserving id (any unique value the caller wants back). */
  ownerId: string;
  nameEncrypted: Buffer;
  nationalIdEncrypted: Buffer;
  phoneEncrypted: Buffer | null;
}

export interface DecryptedOwnerRow {
  ownerId: string;
  name: string;
  nationalId: string;
  phone: string | null;
}

export async function decryptOwnerPiiBatch(
  db: Database,
  rows: readonly EncryptedOwnerRow[],
): Promise<DecryptedOwnerRow[]> {
  if (rows.length === 0) return [];
  const { encKey } = requirePiiKeys();

  // bytea arrays are awkward through pg-node + drizzle's sql template:
  //   - `unnest($1::bytea[])` trips `transformTypeCast` (42846).
  //   - `unnest($1)` without cast can't resolve the function signature
  //     (42883 "no function matches the given name and argument types").
  // Same pain the encrypt batch helper hit on the *text* side and
  // worked around with `jsonb_array_elements_text`. For bytea we
  // hex-encode each buffer to a text-friendly form, pass through the
  // same jsonb_array_elements_text → decode(val, 'hex') pipeline,
  // and recover the original byte sequence inside pg.
  const nameHex = JSON.stringify(rows.map((r) => r.nameEncrypted.toString('hex')));
  const idHex = JSON.stringify(rows.map((r) => r.nationalIdEncrypted.toString('hex')));
  const phoneHex = JSON.stringify(
    rows.map((r) => (r.phoneEncrypted ? r.phoneEncrypted.toString('hex') : null)),
  );

  const [nameRes, idRes, phoneRes] = await Promise.all([
    db.execute<{ dec: string; idx: number }>(
      sql`
        SELECT pgp_sym_decrypt(decode(t.val, 'hex'), ${encKey}) AS dec, t.idx::int AS idx
        FROM jsonb_array_elements_text(${nameHex}::jsonb) WITH ORDINALITY AS t(val, idx)
        ORDER BY t.idx
      `,
    ),
    db.execute<{ dec: string; idx: number }>(
      sql`
        SELECT pgp_sym_decrypt(decode(t.val, 'hex'), ${encKey}) AS dec, t.idx::int AS idx
        FROM jsonb_array_elements_text(${idHex}::jsonb) WITH ORDINALITY AS t(val, idx)
        ORDER BY t.idx
      `,
    ),
    db.execute<{ dec: string | null; idx: number }>(
      sql`
        SELECT
          CASE WHEN t.val IS NULL THEN NULL ELSE pgp_sym_decrypt(decode(t.val, 'hex'), ${encKey}) END AS dec,
          t.idx::int AS idx
        FROM jsonb_array_elements_text(${phoneHex}::jsonb) WITH ORDINALITY AS t(val, idx)
        ORDER BY t.idx
      `,
    ),
  ]);

  if (
    nameRes.rows.length !== rows.length ||
    idRes.rows.length !== rows.length ||
    phoneRes.rows.length !== rows.length
  ) {
    throw new Error(
      `decryptOwnerPiiBatch: row-count mismatch (expected ${rows.length}; got name=${nameRes.rows.length} id=${idRes.rows.length} phone=${phoneRes.rows.length})`,
    );
  }

  const out: DecryptedOwnerRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const name = nameRes.rows[i]?.dec;
    const nationalId = idRes.rows[i]?.dec;
    if (typeof name !== 'string') {
      throw new Error('decryptOwnerPiiBatch: missing name plaintext at idx ' + i);
    }
    if (typeof nationalId !== 'string') {
      throw new Error('decryptOwnerPiiBatch: missing national_id plaintext at idx ' + i);
    }
    out.push({
      ownerId: rows[i]!.ownerId,
      name,
      nationalId,
      phone: phoneRes.rows[i]?.dec ?? null,
    });
  }
  return out;
}

/**
 * V11 perf — name-only batched decrypt for sites that don't need
 * national_id / phone (e.g. calendar-email ICS dispatcher, where the
 * Subject + ATTENDEE-CN line only require the owner name).
 *
 * Single pgcrypto round-trip regardless of input size. Mirrors the
 * `decryptOwnerPiiBatch` hex+jsonb_array_elements_text discipline, but
 * skips the national_id / phone queries entirely — saves 2 RT per
 * batch (~100 ms on Neon) AND avoids materialising PII the caller
 * doesn't use.
 *
 * Caller passes `{ key, nameEncrypted }` records where `key` is any
 * unique value (we hand it back so the caller can map results back
 * to their original rows; the owner UUID is the natural choice but
 * a row index works too).
 */
export interface EncryptedOwnerNameRow {
  key: string;
  nameEncrypted: Buffer;
}

export async function decryptOwnerNamesBatch(
  db: Database,
  rows: readonly EncryptedOwnerNameRow[],
): Promise<Array<{ key: string; name: string }>> {
  if (rows.length === 0) return [];
  const { encKey } = requirePiiKeys();

  const nameHex = JSON.stringify(rows.map((r) => r.nameEncrypted.toString('hex')));
  const nameRes = await db.execute<{ dec: string; idx: number }>(
    sql`
      SELECT pgp_sym_decrypt(decode(t.val, 'hex'), ${encKey}) AS dec, t.idx::int AS idx
      FROM jsonb_array_elements_text(${nameHex}::jsonb) WITH ORDINALITY AS t(val, idx)
      ORDER BY t.idx
    `,
  );
  if (nameRes.rows.length !== rows.length) {
    throw new Error(
      `decryptOwnerNamesBatch: row-count mismatch (expected ${rows.length}; got ${nameRes.rows.length})`,
    );
  }
  return rows.map((r, i) => {
    const name = nameRes.rows[i]?.dec;
    if (typeof name !== 'string') {
      throw new Error('decryptOwnerNamesBatch: missing name plaintext at idx ' + i);
    }
    return { key: r.key, name };
  });
}

/**
 * P0.C1 — data-subject ERASURE (crypto-shred) tombstone.
 *
 * Produces the irreversible replacement ciphertext for an owner's encrypted PII
 * columns (name_encrypted, national_id_encrypted, phone_encrypted). We overwrite
 * the columns with a freshly-encrypted constant tombstone string ("[erased]")
 * rather than NULL because those columns are NOT NULL (name/national_id) and an
 * encrypted-of-a-constant value (a) keeps the at-rest invariant that the column
 * always holds valid pgcrypto ciphertext, and (b) is irreversible w.r.t. the
 * original PII — the original plaintext is GONE; decrypting the tombstone yields
 * only the literal "[erased]", never the subject's data.
 *
 * The HMAC lookup hashes (name_hash, national_id_hash, phone_hash) are set to
 * NULL by the caller (migration 0057 made them nullable) so the owner can no
 * longer be FOUND by HMAC of the original value.
 *
 * Returns the three tombstone ciphertexts in ONE round-trip per the same
 * pgcrypto discipline as the rest of this module (the three encrypts run in a
 * single statement). All three share the same constant plaintext, so an
 * attacker cannot even distinguish which column held which kind of PII.
 */
export const ERASURE_TOMBSTONE_PLAINTEXT = '[erased]';

/**
 * P0.C1 (erasure-completeness HIGH #1) — fixed tombstone for the handwritten-
 * signature SVG blob (`signatures.signature_blob`, bytea NOT NULL).
 *
 * The SVG is the subject's BIOMETRIC mark (their physical signature shape) — PII
 * that survives a crypto-shred of the owner row unless we also redact it here.
 * On erasure we OVERWRITE the blob with this small fixed buffer. The column is
 * NOT NULL, so a constant non-empty buffer satisfies the constraint while
 * destroying the biometric content. We deliberately do NOT delete the signature
 * row: legal validity rests on the retained `document_hash` + `signed_at` + the
 * owner link (proof a signing event occurred), NOT on the visual SVG.
 *
 * Plain (un-encrypted) bytes — the blob column is not pgcrypto-encrypted at
 * rest, so a plaintext tombstone is the correct shape. It carries NO PII.
 */
export const SIGNATURE_BLOB_TOMBSTONE: Buffer = Buffer.from('[erased]');

export async function buildErasureTombstone(
  db: Database,
): Promise<{ nameEncrypted: Buffer; nationalIdEncrypted: Buffer; phoneEncrypted: Buffer }> {
  const { encKey } = requirePiiKeys();
  // One round-trip: three independent pgp_sym_encrypt of the same constant.
  // pgp_sym_encrypt is non-deterministic (random IV) so the three ciphertexts
  // differ at rest even though the plaintext is identical — fine; the point is
  // that none of them is the original PII.
  const result = await db.execute<{ n: Buffer; i: Buffer; p: Buffer }>(
    sql`SELECT
          pgp_sym_encrypt(${ERASURE_TOMBSTONE_PLAINTEXT}, ${encKey}) AS n,
          pgp_sym_encrypt(${ERASURE_TOMBSTONE_PLAINTEXT}, ${encKey}) AS i,
          pgp_sym_encrypt(${ERASURE_TOMBSTONE_PLAINTEXT}, ${encKey}) AS p`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('buildErasureTombstone: pgp_sym_encrypt returned no result');
  return { nameEncrypted: row.n, nationalIdEncrypted: row.i, phoneEncrypted: row.p };
}

void randomBytes; // imported for future signing use
