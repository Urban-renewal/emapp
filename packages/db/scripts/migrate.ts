/**
 * Drizzle migration runner.
 *
 * v8 §v8-S3 — sets the encryption + HMAC GUCs at session start so
 * PII-rotating migrations (e.g. 0033_owners_name_encryption) can
 * backfill via `pgp_sym_encrypt(value, current_setting('app.encryption_key'))`
 * without having to embed the secret in the migration SQL.
 *
 * v8.5 P0 FIX (Audit SOLID #1 + Sec P0-1 — cross-confirmed):
 *   Pre-v8.5 strategy was to SET the GUCs on a checked-out client,
 *   release it, and rely on pg-pool's LIFO checkout order so the
 *   migrator would pick the same client. The own code documented this
 *   as "we can't rely 100% on this" — a P0 fragility because:
 *     1. pg-pool LIFO is an implementation detail, not a contract.
 *     2. node-postgres concurrent pool.connect() calls (e.g. drizzle's
 *        own bookkeeping queries) can race the migrator, returning the
 *        un-GUC'd client to it.
 *     3. On silent failure the migration would encrypt with the
 *        Postgres-default empty string → ciphertexts no one can ever
 *        decrypt; corruption invisible until first read.
 *
 *   v8.5 fix: hold a single dedicated client throughout migrate(),
 *   bind a drizzle instance to THAT client, and run migrate() against
 *   it. No LIFO assumption, no race window. The dedicated drizzle
 *   instance is constructed via `drizzle(client, ...)` which the
 *   node-postgres adapter explicitly supports.
 *
 * Fail-fast sentinel:
 *   If env.PII_ENCRYPTION_KEY is missing, we throw BEFORE running any
 *   migration — better to block CI than to silently produce
 *   undecryptable ciphertexts. (HMAC key is also asserted because the
 *   same 0033 backfill calls hash_field.)
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { pool } from '../src/client';
import { env } from '../src/env';
import * as schema from '../src/schema/index';

async function main() {
  if (!env.PII_ENCRYPTION_KEY || env.PII_ENCRYPTION_KEY.length === 0) {
    throw new Error(
      'PII_ENCRYPTION_KEY is unset — refusing to migrate. ' +
        'Migration 0033 backfills owner name ciphertexts; running with an ' +
        'empty key would produce ciphertexts no one can decrypt. ' +
        'Set PII_ENCRYPTION_KEY (Infisical) and retry.',
    );
  }
  if (!env.PII_HASH_KEY || env.PII_HASH_KEY.length === 0) {
    throw new Error(
      'PII_HASH_KEY is unset — refusing to migrate. ' +
        'Migration 0033 backfills owner name HMACs; running with an empty ' +
        'key would produce a constant hash, breaking uniqueness. ' +
        'Set PII_HASH_KEY (Infisical) and retry.',
    );
  }

  // Dedicated client for the whole migrate() lifecycle — no pool
  // race, no LIFO assumption.
  const client = await pool.connect();
  try {
    // Parameter-bound set_config — no SQL injection risk even if a
    // key ever contained a `'` (it shouldn't — base64 — but the bound
    // form is the principled approach).
    await client.query("SELECT set_config('app.encryption_key', $1, false)", [
      env.PII_ENCRYPTION_KEY,
    ]);
    await client.query("SELECT set_config('app.pii_hash_key', $1, false)", [env.PII_HASH_KEY]);

    // Belt-and-braces: verify the GUCs took. If a future driver
    // change ever swallowed the SET, we'd rather throw here than
    // produce corrupt ciphertexts.
    const verify = await client.query<{ enc: string | null; hash: string | null }>(
      "SELECT current_setting('app.encryption_key', true) AS enc, " +
        "current_setting('app.pii_hash_key', true) AS hash",
    );
    if (!verify.rows[0]?.enc || !verify.rows[0]?.hash) {
      throw new Error(
        'set_config verification failed — GUCs not visible to the migrator ' +
          'session. Refusing to migrate to avoid silent ciphertext corruption.',
      );
    }

    // Bind drizzle to THE SAME client — no pool checkout in between,
    // so the GUCs are guaranteed to be the ones the migrator sees.
    const dedicatedDb = drizzle(client, { schema });
    await migrate(dedicatedDb, { migrationsFolder: './migrations' });
    process.stdout.write('Migrations applied successfully\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration failed: ${String(err)}\n`);
  process.exit(1);
});
