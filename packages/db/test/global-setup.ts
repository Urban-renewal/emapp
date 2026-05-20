import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { pool } from '../src/client';

// Vitest globalSetup runs ONCE in a single process before any test worker
// starts. Running migrate() here (instead of per-suite in parallel workers)
// eliminates the concurrent-migrate DDL race that flaked CI whenever a new
// migration landed (TEST-INFRA DEBT, now resolved — see PROGRESS.md). Every
// new migration is applied automatically; no more one-off apply scripts.
//
// Path resolution: `migrationsFolder` resolves against process.cwd() if
// relative. Earlier this file used `./migrations` which only worked when
// pnpm ran the suite from packages/db. Phase 6 S2 wires the same setup
// into apps/worker + apps/api (so cross-package integration specs can
// rely on a migrated DB) — the resolved-from-this-file path works the
// same regardless of which package's vitest invoked it.
const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'migrations');

export async function setup(): Promise<void> {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // globalSetup runs in its own process; close the pool so it exits cleanly
  // (workers open their own pools against the now-migrated DB).
  await pool.end();
}
