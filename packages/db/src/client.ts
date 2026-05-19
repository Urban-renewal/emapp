import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from './env';
import * as schema from './schema/index';

// Ops-tunable with production-safe HARD fallbacks. The fallback (not just
// a zod .default) is required because @t3-oss/env-core returns raw env
// when SKIP_ENV_VALIDATION / NODE_ENV=test, so a value may be undefined
// or a string here. Tuning guidance: behind the Neon transaction pooler
// (the #1 scale lever, D.24) set DB_POOL_MAX LOWER per pod — the pooler
// multiplexes; many pods × large max exhausts Postgres connections.
const numEnv = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const appPoolConfig = {
  connectionString: env.DATABASE_URL,
  max: numEnv(env.DB_POOL_MAX, 20),
  idleTimeoutMillis: numEnv(env.DB_POOL_IDLE_MS, 30000),
  connectionTimeoutMillis: numEnv(env.DB_POOL_CONN_TIMEOUT_MS, 5000),
  statement_timeout: numEnv(env.DB_STATEMENT_TIMEOUT_MS, 30000),
};

export const pool = new Pool(appPoolConfig);
export const db = drizzle(pool, { schema });
export type Database = NodePgDatabase<typeof schema>;

pool.on('error', (err: Error) => {
  process.stderr.write(`[appPool] idle client error: ${err.message}\n`);
});

const providerPoolConfig = {
  connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
  max: numEnv(env.DB_PROVIDER_POOL_MAX, 5),
  idleTimeoutMillis: numEnv(env.DB_POOL_IDLE_MS, 30000),
  connectionTimeoutMillis: numEnv(env.DB_POOL_CONN_TIMEOUT_MS, 5000),
  statement_timeout: numEnv(env.DB_PROVIDER_STATEMENT_TIMEOUT_MS, 60000),
};

export const providerPool = new Pool(providerPoolConfig);
export const providerDb = drizzle(providerPool, { schema });
export type ProviderDatabase = NodePgDatabase<typeof schema>;

providerPool.on('error', (err: Error) => {
  process.stderr.write(`[providerPool] idle client error: ${err.message}\n`);
});

// Drain helper for process-level graceful shutdown (apps/api SIGTERM/SIGINT).
// Pool.end() throws if already ended; we swallow per-pool so a duplicate
// close (e.g. Nest enableShutdownHooks running concurrently) is a no-op.
export async function closeAllPools(): Promise<void> {
  await pool.end().catch(() => undefined);
  await providerPool.end().catch(() => undefined);
}
