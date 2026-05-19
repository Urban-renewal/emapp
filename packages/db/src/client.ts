import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

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

// Neon (and any pooled Postgres) drops idle backend connections server-side
// after its own idle cutoff. Three robustness levers, all required:
//  - keepAlive: TCP keepalive probes so a half-open/dead socket is detected
//    proactively instead of on the next checkout.
//  - keepAliveInitialDelayMillis: pg passes this to socket.setKeepAlive
//    AS-IS; if omitted Node uses the OS default (~7200s on Linux), which
//    is useless against Neon's minutes-scale idle cutoff — probes would
//    never fire before the backend dies. 10s starts probing well inside
//    every realistic idle window.
//  - allowExitOnIdle:false: an idle, empty pool must NEVER let the Node
//    process exit (it's a long-lived API; explicit even though it's the pg
//    default, so a future pg default flip can't silently kill us).
const resilientPoolDefaults = {
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  allowExitOnIdle: false,
};

// The pg Pool only re-emits errors from *idle* clients to `pool.on('error')`.
// A client whose connection Neon terminates while it is *checked out* (a
// long-running session holding the connection) emits 'error' on the Client
// itself — with no listener that is an unhandled 'error' event and Node
// exits 1, taking the whole API down on a single transient DB blip.
//
// The per-client listener attached on `connect` is the single source of
// truth: it fires for every client error (idle OR checked-out) and is the
// ONLY log line we emit per event. We still register a pool-level 'error'
// listener — pg-pool re-emits idle client errors via `pool.emit('error')`
// (see pg-pool/index.js makeIdleListener), and an EventEmitter with no
// 'error' listener throws synchronously, reintroducing the same crash
// class for idle drops. The pool listener is therefore intentionally a
// silent backstop, not a second log line.
const attachClientErrorGuard = (poolLabel: string, p: Pool): void => {
  p.on('connect', (client: PoolClient) => {
    client.on('error', (err: Error) => {
      process.stderr.write(`[${poolLabel}] client error (reaped): ${err.message}\n`);
    });
  });
  // Silent backstop — see comment above. DO NOT remove: without an 'error'
  // listener on the Pool, pg's idle re-emit crashes the process.
  p.on('error', () => {});
};

const appPoolConfig = {
  connectionString: env.DATABASE_URL,
  max: numEnv(env.DB_POOL_MAX, 20),
  idleTimeoutMillis: numEnv(env.DB_POOL_IDLE_MS, 30000),
  connectionTimeoutMillis: numEnv(env.DB_POOL_CONN_TIMEOUT_MS, 5000),
  statement_timeout: numEnv(env.DB_STATEMENT_TIMEOUT_MS, 30000),
  ...resilientPoolDefaults,
};

export const pool = new Pool(appPoolConfig);
export const db = drizzle(pool, { schema });
export type Database = NodePgDatabase<typeof schema>;

attachClientErrorGuard('appPool', pool);

const providerPoolConfig = {
  connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
  max: numEnv(env.DB_PROVIDER_POOL_MAX, 5),
  idleTimeoutMillis: numEnv(env.DB_POOL_IDLE_MS, 30000),
  connectionTimeoutMillis: numEnv(env.DB_POOL_CONN_TIMEOUT_MS, 5000),
  statement_timeout: numEnv(env.DB_PROVIDER_STATEMENT_TIMEOUT_MS, 60000),
  ...resilientPoolDefaults,
};

export const providerPool = new Pool(providerPoolConfig);
export const providerDb = drizzle(providerPool, { schema });
export type ProviderDatabase = NodePgDatabase<typeof schema>;

attachClientErrorGuard('providerPool', providerPool);
