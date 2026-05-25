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

// Resilience guard observability hook. @emapp/db deliberately has NO
// Sentry / metrics dependency — the API bootstrap injects an observer
// via setPoolErrorObserver() (see apps/api/src/instrument.ts). When
// unset, the guard still writes to stderr (defense in depth for ops
// grep) and contains the failure; observability is purely additive.
//
// Only err.message is forwarded: pg connection-layer messages are
// protocol-level (no query text, no PII). err.stack is intentionally
// NOT forwarded — surrounding async frames can carry call-site context
// that hasn't been audited for PII.
//
// `source` is a single value 'client' rather than 'idle'|'checked-out':
// the per-client listener (the only one that logs/notifies) sees errors
// for clients in BOTH states. pg-pool re-emits idle client errors to
// pool.emit('error') ON TOP of the per-client 'error' event, so a 'source'
// distinction at the pool listener would either duplicate (one notify per
// layer) or require fragile access to pg internals (pool._idle). Telemetry
// consumers that need to distinguish can classify by err.message.
export type PoolName = 'appPool' | 'providerPool';
export type PoolErrorSource = 'client';
export interface PoolErrorEvent {
  pool: PoolName;
  source: PoolErrorSource;
  message: string;
}
export type PoolErrorObserver = (event: PoolErrorEvent) => void;

let poolErrorObserver: PoolErrorObserver | undefined;

export function setPoolErrorObserver(observer: PoolErrorObserver | undefined): void {
  poolErrorObserver = observer;
}

function notifyPoolErrorObserver(event: PoolErrorEvent): void {
  const fn = poolErrorObserver;
  if (!fn) return;
  try {
    fn(event);
  } catch {
    /* observer must never weaken the guard */
  }
}

// The pg Pool only re-emits errors from *idle* clients to `pool.on('error')`.
// A client whose connection Neon terminates while it is *checked out* (a
// long-running session holding the connection) emits 'error' on the Client
// itself — with no listener that is an unhandled 'error' event and Node
// exits 1, taking the whole API down on a single transient DB blip.
//
// The per-client listener attached on `connect` is the single source of
// truth: it fires for every client error (idle OR checked-out) and is the
// ONLY path that logs/notifies (dedup contract pinned by
// pool-resilience.spec.ts). The pool-level 'error' listener is registered
// as a SILENT backstop: pg-pool re-emits idle client errors via
// pool.emit('error') (see pg-pool/index.js makeIdleListener), and an
// EventEmitter with no 'error' listener throws synchronously, reintroducing
// the same crash class for idle drops. DO NOT remove the pool listener.
export function attachClientErrorGuard(p: Pool, name: PoolName): void {
  p.on('connect', (client: PoolClient) => {
    client.on('error', (err: Error) => {
      process.stderr.write(`[${name}] client error (reaped): ${err.message}\n`);
      notifyPoolErrorObserver({ pool: name, source: 'client', message: err.message });
    });
  });
  // Silent backstop — see comment above. DO NOT remove: without an 'error'
  // listener on the Pool, pg's idle re-emit crashes the process.
  p.on('error', () => {});
}

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

attachClientErrorGuard(pool, 'appPool');

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

// ───────────────────────────────────────────────────────────────────
// D.37 / Phase 6.5 — pool stats accessor + storage error observer.
// Both surface internal state for the Provider system-health endpoint
// WITHOUT exposing the pool / storage objects themselves. The principle
// is the same as `setPoolErrorObserver` above: read-only telemetry,
// no mutation surface.
// ───────────────────────────────────────────────────────────────────

export interface PoolStatsSnapshot {
  /** Currently checked-out + idle clients combined (clients owned by the pool). */
  total: number;
  /** Idle (returned to pool, available for next checkout). */
  idle: number;
  /** Queued requests awaiting a pool slot. */
  waiting: number;
}

export interface AllPoolsStats {
  app: PoolStatsSnapshot;
  provider: PoolStatsSnapshot;
}

/**
 * Read-only snapshot of both pg pool gauges. Used by
 * `GET /provider/system-health` (D.37). Returns NEW number-only
 * objects — callers cannot mutate the pools through this.
 *
 * The values come straight from pg-pool's documented properties
 * (`totalCount` / `idleCount` / `waitingCount`). They are gauges,
 * not metrics over time — sampling at health-check rate is fine.
 */
export function getPoolStats(): AllPoolsStats {
  return {
    app: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
    provider: {
      total: providerPool.totalCount,
      idle: providerPool.idleCount,
      waiting: providerPool.waitingCount,
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Storage error observer — parallel to `setPoolErrorObserver`.
// The R2StorageProvider (apps/api + apps/worker) NOTIFIES via this
// hook when any S3 SDK call fails. The Provider system-health endpoint
// READS the accumulated counter + last-error timestamp.
// ───────────────────────────────────────────────────────────────────

export interface StorageErrorEvent {
  /** Operation that failed (e.g. 'put', 'get', 'head', 'delete'). */
  op: string;
  /** Error class name (e.g. 'NoSuchKey', 'TimeoutError'). NEVER the message. */
  errorClass: string;
}

export type StorageErrorObserver = (event: StorageErrorEvent) => void;

let storageErrorObserver: StorageErrorObserver | undefined;
let storageErrorCount = 0;
let storageLastErrorAt: Date | null = null;

/**
 * Replace the storage error observer (one slot, same pattern as
 * `setPoolErrorObserver`). The default observer is a built-in counter
 * surfaced via `getStorageErrorStats()` — calling this lets ops bolt
 * on Sentry forwarding without losing the counter.
 *
 * The observer fires AFTER the built-in counter increments, so the
 * health endpoint always reflects accurate totals even with an
 * observer attached.
 */
export function setStorageErrorObserver(observer: StorageErrorObserver | undefined): void {
  storageErrorObserver = observer;
}

/**
 * Storage providers call this on every error to keep the system-
 * health counter accurate. The built-in counter NEVER throws; the
 * caller's hot path is unaffected.
 */
export function recordStorageError(event: StorageErrorEvent): void {
  storageErrorCount += 1;
  storageLastErrorAt = new Date();
  const fn = storageErrorObserver;
  if (!fn) return;
  try {
    fn(event);
  } catch {
    /* observer must never weaken the counter */
  }
}

export interface StorageErrorStats {
  errorsSinceBoot: number;
  lastErrorAt: Date | null;
}

export function getStorageErrorStats(): StorageErrorStats {
  return { errorsSinceBoot: storageErrorCount, lastErrorAt: storageLastErrorAt };
}

/** Test seam — reset the counter between specs so cross-spec state
 *  doesn't leak. Intentionally NOT exported via index.ts (test-only). */
export function resetStorageErrorStatsForTests(): void {
  storageErrorCount = 0;
  storageLastErrorAt = null;
}

attachClientErrorGuard(providerPool, 'providerPool');

/**
 * Drain both pools — used by the process-level SIGTERM/SIGINT handler
 * in `apps/api/src/process-guards.ts` (and any future graceful-shutdown
 * path in the worker). Per-pool `.catch(() => undefined)` swallows
 * duplicate-`.end()` errors so the call is safe when Nest's
 * `enableShutdownHooks()` ALSO drains via its own teardown — both can
 * race; the second wins is a no-op.
 *
 * Kept inside @emapp/db so callers don't reach into `providerPool`
 * directly (matches the D.21 "direct pool access is internal" rule).
 */
export async function closeAllPools(): Promise<void> {
  await pool.end().catch(() => undefined);
  await providerPool.end().catch(() => undefined);
}
