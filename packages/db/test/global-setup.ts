import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { pool } from '../src/client';

// Vitest globalSetup runs ONCE per vitest invocation. Within a single
// package's `pnpm test` that single-process guarantee eliminated the
// concurrent-migrate DDL race that originally flaked CI. BUT: turbo
// runs `pnpm test` in parallel across @emapp/db + @emapp/worker +
// @emapp/api — each invocation has its OWN globalSetup, and all three
// hit the same Neon DB concurrently. Three concurrent
// `CREATE EXTENSION IF NOT EXISTS citext` calls race on the
// pg_extension_name_index unique constraint (Postgres's IF NOT EXISTS
// is NOT atomic across concurrent sessions — it's a check-then-create,
// not a single guarded statement).
//
// Fix: take a session-scoped advisory lock on a hard-coded key BEFORE
// calling migrate(). Postgres's `pg_advisory_lock(BIGINT)` blocks
// other sessions trying the same key — first session through migrates
// (idempotent), subsequent sessions wait, then no-op (every migration
// is already applied).
//
// The lock must live on a DEDICATED Client (NOT pool-borrowed) — the
// drizzle migrate() pulls its own connections from the pool, so the
// lock can't share a connection with the migrate. After migrate()
// returns we release the lock + close both the lock-client and the
// pool.
const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'migrations');

// Stable arbitrary key — any constant works as long as ALL packages
// use THIS key. Choose a value distinctive to emapp tests so it
// doesn't collide with any future application-side advisory locks.
// (Postgres pg_advisory_lock takes a BIGINT; the int4 range is fine.)
const MIGRATE_LOCK_KEY = 0x14d4_e3a4;

export async function setup(): Promise<void> {
  // Acquire a session-scoped advisory lock on a dedicated PoolClient
  // BEFORE running migrate(). Holds across the entire migrate() call;
  // any other vitest globalSetup (in db / worker / api running in
  // parallel via turbo) on the same DB will block here until we
  // release. After we release, the next globalSetup runs migrate()
  // which is a no-op (every migration is already applied) — but
  // crucially CREATE EXTENSION + other DDL no longer race.
  //
  // Using a PoolClient (not a Client(connectionString)) so the worker
  // + api packages don't need a direct `pg` dep — they reach pg only
  // via @emapp/db's pool.
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);

    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // Release the lock explicitly before returning the client to the
    // pool. (Session-scoped locks are released on session-end too,
    // but explicit unlock is cleaner + immediate.)
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]);
  } finally {
    lockClient.release();
  }

  // globalSetup runs in its own process; close the pool so it exits
  // cleanly (workers open their own pools against the now-migrated DB).
  await pool.end();
}
