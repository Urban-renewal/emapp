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
 *
 * v8.5 test seam:
 *   `assertPiiKeysPresent` + `setupAndVerifyGucs` are exported so
 *   migrator-guards.spec.ts can pin the fail-fast contract WITHOUT
 *   running the full migrator. The main() entrypoint is the
 *   composition; no logic lives there that isn't tested through one
 *   of these helpers.
 */
import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';

import { env } from '../src/env';
import * as schema from '../src/schema/index';

/** v8.5 fail-fast sentinel — refuses to migrate without keys.
 *  Exported so tests can pin the EXACT error messages a future hand
 *  doesn't accidentally weaken (a "missing key? log a warning and
 *  proceed" patch is a P0 silent-corruption regression). */
export function assertPiiKeysPresent(input: {
  PII_ENCRYPTION_KEY?: string | null;
  PII_HASH_KEY?: string | null;
}): void {
  if (!input.PII_ENCRYPTION_KEY || input.PII_ENCRYPTION_KEY.length === 0) {
    throw new Error(
      'PII_ENCRYPTION_KEY is unset — refusing to migrate. ' +
        'Migration 0033 backfills owner name ciphertexts; running with an ' +
        'empty key would produce ciphertexts no one can decrypt. ' +
        'Set PII_ENCRYPTION_KEY (Infisical) and retry.',
    );
  }
  if (!input.PII_HASH_KEY || input.PII_HASH_KEY.length === 0) {
    throw new Error(
      'PII_HASH_KEY is unset — refusing to migrate. ' +
        'Migration 0033 backfills owner name HMACs; running with an empty ' +
        'key would produce a constant hash, breaking uniqueness. ' +
        'Set PII_HASH_KEY (Infisical) and retry.',
    );
  }
}

/** v8.5 — set + verify both GUCs on the given client.
 *
 *  CRITICAL: this function uses SESSION-level `set_config(..., is_local=false)`
 *  so the values persist for every transaction drizzle's `migrate()` opens
 *  afterwards. That means DATABASE_URL MUST point at a **session-pooled**
 *  Neon endpoint (the non-`-pooler` host) or to direct backend — NOT at
 *  Neon's transaction pooler. Transaction pooling returns a different
 *  physical backend per transaction, so the session GUCs we set here are
 *  invisible to the migrator's first BEGIN.
 *
 *  We do set + verify inside a SINGLE explicit transaction first, both as
 *  a smoke test (transaction-pooled endpoints will see the value within
 *  the same tx) AND so the failure surfaces immediately with a clear
 *  error message instead of as silent ciphertext corruption six migrations
 *  later. The verify SELECT inside the tx confirms the SET reached the
 *  backend. We then EXIT the tx — leaving the GUC at session level — and
 *  re-verify outside the tx; if THAT verify fails, we know the endpoint
 *  is transaction-pooled and fail with an actionable message.
 *
 *  Throws if the GUC isn't visible after the SET. Exported so the
 *  migrator-guards spec can drive a real pg client through it.
 */
export async function setupAndVerifyGucs(
  client: PoolClient,
  keys: { PII_ENCRYPTION_KEY: string; PII_HASH_KEY: string },
): Promise<void> {
  // Parameter-bound set_config — no SQL injection risk even if a key
  // ever contained a `'` (it shouldn't — base64 — but the bound form
  // is the principled approach).
  await client.query("SELECT set_config('app.encryption_key', $1, false)", [
    keys.PII_ENCRYPTION_KEY,
  ]);
  await client.query("SELECT set_config('app.pii_hash_key', $1, false)", [keys.PII_HASH_KEY]);

  // First verify INSIDE an explicit transaction. On any pooler mode
  // (transaction or session) Postgres routes all queries within a
  // transaction to the same backend, so the SET above is guaranteed
  // visible here. This is the unit-level "the SET reached a backend"
  // check.
  await client.query('BEGIN');
  try {
    const verifyInTx = await client.query<{ enc: string | null; hash: string | null }>(
      "SELECT current_setting('app.encryption_key', true) AS enc, " +
        "current_setting('app.pii_hash_key', true) AS hash",
    );
    if (!verifyInTx.rows[0]?.enc || !verifyInTx.rows[0]?.hash) {
      throw new Error(
        'set_config verification failed INSIDE a single transaction — the SET ' +
          'did not reach a backend at all. This is a driver / network issue, ' +
          'not a pooler mode issue. Refusing to migrate.',
      );
    }
  } finally {
    await client.query('COMMIT');
  }

  // Now verify the GUC persists OUTSIDE the transaction. On
  // session-pooled / direct backends, the value is still there. On
  // Neon's TRANSACTION pooler (host suffix `-pooler`), the next query
  // gets routed to a different backend that has no GUC set — and
  // current_setting returns NULL/'' for our custom GUC. This catches
  // the misconfigured endpoint with an actionable error.
  const verifySession = await client.query<{ enc: string | null; hash: string | null }>(
    "SELECT current_setting('app.encryption_key', true) AS enc, " +
      "current_setting('app.pii_hash_key', true) AS hash",
  );
  if (!verifySession.rows[0]?.enc || !verifySession.rows[0]?.hash) {
    throw new Error(
      'set_config verification failed OUTSIDE the transaction — the GUC ' +
        'did not persist at session level. This indicates DATABASE_URL points ' +
        'at a transaction-pooled endpoint (Neon "-pooler" host). The migrator ' +
        'requires a session-pooled or direct endpoint so the encryption GUC ' +
        'survives every BEGIN drizzle opens. Refusing to migrate to avoid ' +
        'silent ciphertext corruption.',
    );
  }
}

async function main() {
  assertPiiKeysPresent({
    PII_ENCRYPTION_KEY: env.PII_ENCRYPTION_KEY,
    PII_HASH_KEY: env.PII_HASH_KEY,
  });

  // v8.5 — Neon's `-pooler` host is TRANSACTION-pooled (pgbouncer-style):
  // each statement may go to a different backend, so SET LOCAL / session
  // GUCs do not survive across drizzle's per-migration transactions.
  // DATABASE_MIGRATE_URL is the DIRECT endpoint (no `-pooler` in host)
  // and is used ONLY by this script. Falls back to DATABASE_URL when
  // unset so local-dev workflows keep working with a single env var.
  const connectionString = env.DATABASE_MIGRATE_URL ?? env.DATABASE_URL;
  const usingMigrateUrl = !!env.DATABASE_MIGRATE_URL;
  process.stdout.write(
    `Migrator: using ${usingMigrateUrl ? 'DATABASE_MIGRATE_URL (direct)' : 'DATABASE_URL'}\n`,
  );

  // Dedicated pool sized at 1 connection — the migrator only ever
  // needs the single client held below. Tiny max prevents accidentally
  // starving Neon's connection budget if the script is run alongside
  // the API/worker.
  const migratorPool = new Pool({
    connectionString,
    max: 1,
    // Same resilience knobs as src/client.ts so a transient Neon
    // disconnect during a long migration doesn't kill the run.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    allowExitOnIdle: false,
    statement_timeout: 600_000, // 10 min — migrations can take a while
  });

  // Dedicated client for the whole migrate() lifecycle — no pool
  // race, no LIFO assumption.
  const client = await migratorPool.connect();
  try {
    await setupAndVerifyGucs(client, {
      PII_ENCRYPTION_KEY: env.PII_ENCRYPTION_KEY!,
      PII_HASH_KEY: env.PII_HASH_KEY!,
    });

    // Bind drizzle to THE SAME client — no pool checkout in between,
    // so the GUCs are guaranteed to be the ones the migrator sees.
    const dedicatedDb = drizzle(client, { schema });
    await migrate(dedicatedDb, { migrationsFolder: './migrations' });
    process.stdout.write('Migrations applied successfully\n');
  } finally {
    client.release();
    await migratorPool.end();
  }
}

// Only run as a script when this file is the CLI entrypoint.
// Spec files import `assertPiiKeysPresent` / `setupAndVerifyGucs`
// directly and MUST NOT trigger main().
//
// v8.5 Windows fix: previous comparison hand-built `file://<path>` from
// `process.argv[1]`, which on POSIX produces `file:///abs/path` (3
// slashes) but on Windows produced `file://C:/path` (2 slashes) — so
// `isCli` was always false on Windows and the migrator exited silently.
// `pathToFileURL` handles both platforms uniformly.
const cliHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === cliHref) {
  main().catch((err: unknown) => {
    process.stderr.write(`Migration failed: ${String(err)}\n`);
    process.exit(1);
  });
}
