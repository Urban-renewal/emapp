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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';

import { resolveDbTarget } from '../src/db-target';
import { env } from '../src/env';
import {
  checkJournalIntegrity,
  findWatermarkSkipViolations,
  type Journal,
  type WatermarkSkipEntry,
} from '../src/migrations/journal-integrity';
import * as schema from '../src/schema/index';

/**
 * v12 silent-skip preflight — assert the migration journal is healthy BEFORE
 * connecting to any db. The migrator silently skips a journal entry whose
 * `when` is below the db's current watermark (drizzle takes a single
 * MAX(created_at) snapshot and never advances it in-loop), so a hand-authored
 * entry with a too-low `when` would vanish with a misleading "applied
 * successfully". This runs the same pure guard the CI spec pins
 * (journal-integrity.spec.ts) at the real migrate moment — CI + boot, per the
 * M-1 finding. Exported so migrator-guards.spec.ts can pin it without a db.
 */
export function assertJournalIntegrity(migrationsFolder: string): void {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`Migration journal not found at ${journalPath} — refusing to migrate.`);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const violations = checkJournalIntegrity(journal, (tag) =>
    existsSync(join(migrationsFolder, `${tag}.sql`)),
  );
  if (violations.length > 0) {
    const lines = violations.map((v) => `  - [${v.kind}] idx ${v.idx} (${v.tag}): ${v.detail}`);
    throw new Error(
      `Migration journal integrity check failed — refusing to migrate:\n${lines.join('\n')}`,
    );
  }
}

/**
 * Read each journal entry + the sha256(hex) of its `.sql` file — computed the
 * EXACT way drizzle's `readMigrationFiles` does it: `sha256(rawFileContent)`,
 * hex digest, over the whole file (NOT per-statement). Pure read of the
 * migrations folder; no db. Exported so the runtime-drift preflight composes
 * over a value the spec can also build by hand.
 */
export function readJournalEntryHashes(migrationsFolder: string): WatermarkSkipEntry[] {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`Migration journal not found at ${journalPath} — refusing to migrate.`);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  return (journal.entries ?? []).map((entry) => {
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    const content = readFileSync(sqlPath, 'utf8');
    return {
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256').update(content).digest('hex'),
    };
  });
}

/**
 * v12+ POST-connect runtime-drift preflight — catches the watermark-vs-journal
 * divergence variant of M-1 (real incident 2026-06-23) that the pure static
 * `assertJournalIntegrity` CANNOT see.
 *
 * The static guard only proves the journal is internally monotonic. It is blind
 * to the live db state. The incident: the dev `__drizzle_migrations` watermark
 * was a leftover pre-renumber `when` (1783586400000) sitting ABOVE
 * `0079_external_share`'s `when` (1783500000000) — so drizzle's single
 * MAX(created_at) snapshot would have SILENTLY SKIPPED 0079 (its `when` is below
 * the watermark, its hash not yet applied) while still logging "applied
 * successfully". This preflight reads the live applied set, computes the
 * watermark, and throws if ANY journal entry would be silently skipped.
 *
 * Read-only: it SELECTs from `drizzle.__drizzle_migrations` and (on violation)
 * throws BEFORE drizzle's `migrate()` runs. It NEVER mutates. Fresh db (table
 * absent / empty) → no watermark → no violation → proceeds silently.
 *
 * Exported helper `readJournalEntryHashes` + the pure
 * `findWatermarkSkipViolations` carry the logic; this function is the thin
 * db-reading composition.
 */
export async function assertNoWatermarkSkip(
  client: PoolClient,
  migrationsFolder: string,
): Promise<void> {
  // 1) Read the applied set. Handle the table-absent case (fresh db) as "no
  //    rows" rather than an error — to_regclass returns NULL when the table
  //    does not exist, letting us branch without catching a 42P01.
  const tableCheck = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (!tableCheck.rows[0]?.exists) {
    // Fresh db — drizzle will create the table and apply everything in idx
    // order. No watermark, no possible silent skip.
    return;
  }

  const applied = await client.query<{ hash: string; created_at: string | null }>(
    'SELECT hash, created_at FROM drizzle.__drizzle_migrations',
  );
  const appliedHashes = new Set<string>(applied.rows.map((r) => r.hash));
  const createdAts = applied.rows
    .map((r) => (r.created_at === null ? null : Number(r.created_at)))
    .filter((c): c is number => c !== null);
  // 2) watermark = MAX(created_at) over applied rows. Empty set → fresh-ish db
  //    (table present, no rows) → null → no violation.
  const watermark = createdAts.length > 0 ? Math.max(...createdAts) : null;

  // 3) Compute each journal entry's hash drizzle's way, then 4) detect skips.
  const journalEntries = readJournalEntryHashes(migrationsFolder);
  const violations = findWatermarkSkipViolations({ appliedHashes, watermark, journalEntries });

  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `  - idx ${v.idx} (${v.tag}): when ${v.when} <= db watermark ${watermark}`,
    );
    throw new Error(
      'Migration watermark-skip check failed — refusing to migrate:\n' +
        `${lines.join('\n')}\n` +
        `The db's __drizzle_migrations watermark (${watermark}) is at or above the ` +
        'above journal `when`s whose migrations are NOT yet applied. Drizzle takes a ' +
        'single MAX(created_at) snapshot and would SILENTLY SKIP these while reporting ' +
        'success (the M-1 watermark-divergence class, real incident 2026-06-23).\n' +
        'Remediation: either apply the listed migration SQL out-of-band and insert its ' +
        'row into drizzle.__drizzle_migrations (hash + created_at = the journal `when`), ' +
        'or reconcile the journal/watermark so no unapplied entry sits below the watermark. ' +
        'Do NOT just bump the `when` of an already-applied entry — that re-applies it elsewhere.',
    );
  }
}

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
  // Preflight #0 — journal integrity. Cheap, no db, runs first so a
  // silent-skip-inducing journal fails loud before we touch Neon.
  assertJournalIntegrity('./migrations');

  assertPiiKeysPresent({
    PII_ENCRYPTION_KEY: env.PII_ENCRYPTION_KEY,
    PII_HASH_KEY: env.PII_HASH_KEY,
  });

  // The migrator needs a DIRECT (or session-pooled) endpoint so the session-
  // level encryption GUCs below survive every BEGIN drizzle opens. The target
  // resolver owns that choice: for `neon` it returns DATABASE_MIGRATE_URL (the
  // direct host) falling back to DATABASE_URL; for `local` it returns the
  // local URL (no pooler). One flag, no per-script URL juggling.
  const dbTarget = resolveDbTarget(env);
  const connectionString = dbTarget.migrateUrl;
  process.stdout.write(
    `Migrator: DB_TARGET=${dbTarget.target} (${
      dbTarget.migrateDirect
        ? 'direct endpoint'
        : 'WARNING: pooled DATABASE_URL fallback — set DATABASE_MIGRATE_URL to a direct endpoint'
    })\n`,
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

    // Preflight #1 — POST-connect runtime-drift guard. The pure preflight #0
    // above proves the journal is internally healthy; THIS one reads the live
    // applied set and throws if the db watermark would make drizzle silently
    // skip an unapplied entry (the M-1 watermark-divergence incident). Runs on
    // the same dedicated client, read-only, before any apply.
    await assertNoWatermarkSkip(client, './migrations');

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
