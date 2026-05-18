import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { pool } from '../src/client';

// Vitest globalSetup runs ONCE in a single process before any test worker
// starts. Running migrate() here (instead of per-suite in parallel workers)
// eliminates the concurrent-migrate DDL race that flaked CI whenever a new
// migration landed (TEST-INFRA DEBT, now resolved — see PROGRESS.md). Every
// new migration is applied automatically; no more one-off apply scripts.
export async function setup(): Promise<void> {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './migrations' });
  // globalSetup runs in its own process; close the pool so it exits cleanly
  // (workers open their own pools against the now-migrated DB).
  await pool.end();
}
