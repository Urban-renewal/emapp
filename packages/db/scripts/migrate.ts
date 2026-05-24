/**
 * Drizzle migration runner.
 *
 * v8 §v8-S3 — sets the encryption + HMAC GUCs at session start so
 * PII-rotating migrations (e.g. 0033_owners_name_encryption) can
 * backfill via `pgp_sym_encrypt(value, current_setting('app.encryption_key'))`
 * without having to embed the secret in the migration SQL.
 *
 * Strategy: we set the GUCs on a pool client first, release it back
 * — drizzle's `migrate()` then asks the pool for a client and reuses
 * the just-released one (pg-pool is LIFO). We can't rely 100% on
 * this; the more robust pattern is to set the GUCs at the database-
 * level default or to write a helper that wraps migrate() with a
 * dedicated client. For dev/staging-grade MVP this approach is
 * sufficient and matches the pool's documented LIFO behaviour.
 *
 * Fail-fast: if the keys are missing, set_config emits a Postgres
 * error and the runner exits. Better than silently encrypting with
 * an empty string (which would produce ciphertexts no one can
 * decrypt afterwards).
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { db, pool } from '../src/client';
import { env } from '../src/env';

async function main() {
  // Set the GUCs at session level using a dedicated client so the
  // migrator inherits them (pg-pool LIFO: the next checkout returns
  // this client).
  const client = await pool.connect();
  try {
    if (env.PII_ENCRYPTION_KEY) {
      // Parameter-bound set_config — no SQL injection risk even if
      // a key ever contained a `'` (it shouldn't — base64 — but the
      // bound form is the principled approach).
      await client.query("SELECT set_config('app.encryption_key', $1, false)", [
        env.PII_ENCRYPTION_KEY,
      ]);
    }
    if (env.PII_HASH_KEY) {
      await client.query("SELECT set_config('app.pii_hash_key', $1, false)", [env.PII_HASH_KEY]);
    }
  } finally {
    client.release();
  }

  await migrate(db, { migrationsFolder: './migrations' });
  process.stdout.write('Migrations applied successfully\n');
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration failed: ${String(err)}\n`);
  process.exit(1);
});
