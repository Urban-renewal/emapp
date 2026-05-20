/**
 * EMAPP worker — process entry.
 *
 * Phase 6 S2 (this commit): pg-boss queue subscription wired. The
 * worker now boots, starts pg-boss against the same Postgres pool the
 * API uses (pgboss owns its tables in the `pgboss` schema; isolated
 * from our domain tables), registers IJobHandler implementations via
 * the adapter, and blocks on SIGTERM. On SIGTERM: stop pg-boss
 * (drains active jobs up to the shutdown window) → drain pino → exit 0.
 *
 * Architecture (locked):
 *  - Separate Railway service from @emapp/api (docs/02 §354 + docs/03
 *    §1424).
 *  - Queue backend = pg-boss (docs/02 §354 + D.04 — no Redis in MVP).
 *
 * Operational contract (docs/07 §13 incident response):
 *  - Logs structured JSON via pino (parsable in Railway / Sentry).
 *  - SIGTERM = graceful boss.stop() then exit 0.
 *  - Process MUST exit non-zero on unrecoverable error so Railway
 *    restarts it (D.29 resilience: crash handlers exit 1).
 *
 * Composition root only — no logic. Each piece (smokeTestDb, signal
 * handlers, crash handlers, pg-boss adapter, handler) is independently
 * testable. main.ts wires real `process.exit`, real `pool`, real
 * pg-boss, and real IJobHandler instances.
 */
import { env, pool } from '@emapp/db';
// eslint-disable-next-line import/no-named-as-default
import PgBoss from 'pg-boss';
// eslint-disable-next-line import/no-named-as-default
import pino from 'pino';

import { registerCrashHandlers, registerSignalHandlers, smokeTestDb } from './bootstrap';
import { ImportJobHandler } from './handlers/import-job.handler';
import { registerHandler, type BossLike } from './pg-boss-adapter';

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'emapp-worker' },
});

/** Drain window after boss.stop() before exiting. 1500ms = enough for
 *  pg-boss to finalize the in-flight job and for pino to flush. The
 *  larger window vs S1.5's 250ms reflects that we now have actual
 *  work to drain. Real-world tuning happens at S7 perf gates. */
const SHUTDOWN_DRAIN_MS = 1500;

/** pg-boss schema name — keeps queue plumbing isolated from the public
 *  schema where our domain tables live. The pgboss role is created on
 *  first start(). Same connection string as the app pool; pg-boss owns
 *  its own internal pool inside that connection. */
const PG_BOSS_SCHEMA = 'pgboss';

async function main(): Promise<void> {
  log.info('worker booting');

  try {
    await smokeTestDb(pool);
    log.info('db connectivity OK');
  } catch (e: unknown) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'db smoke-test failed');
    process.exit(1);
  }

  // Shared abort signal — fires on SIGTERM so handlers can short-circuit
  // long parse/validate/persist steps and pg-boss.stop() can return.
  const shutdownController = new AbortController();

  // Construct pg-boss. Two notes:
  //  - We pass connectionString (NOT the existing `pool`) so pg-boss
  //    owns its own pg client. That's the supported v10 pattern; sharing
  //    a Pool requires the `db` option with a custom executeSql adapter
  //    and isn't necessary for our scale.
  //  - migrate:true (default) lets pg-boss apply its own schema on first
  //    start. Idempotent; safe to leave on in prod.
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: PG_BOSS_SCHEMA,
  });

  boss.on('error', (err: Error): void => {
    log.error({ err: err.message }, 'pg-boss internal error');
  });

  try {
    await boss.start();
    log.info({ schema: PG_BOSS_SCHEMA }, 'pg-boss started');
  } catch (e: unknown) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'pg-boss start failed');
    process.exit(1);
  }

  // Register handlers. The list is intentionally small (Phase 6 has one
  // job type); future phases (Phase 7 export, notifications) add more.
  const importHandler = new ImportJobHandler();
  try {
    await registerHandler({
      // pg-boss v10's class shape is compatible with BossLike (we only
      // touch the four methods declared on the interface).
      boss: boss as unknown as BossLike,
      registration: {
        handler: importHandler,
        payloadSchema: importHandler.payloadSchema,
      },
      log: {
        info: (msg, meta) => log.info(meta ?? {}, msg),
        warn: (msg, meta) => log.warn(meta ?? {}, msg),
        error: (msg, meta) => log.error(meta ?? {}, msg),
      },
      signal: shutdownController.signal,
    });
    log.info({ name: importHandler.name }, 'handler registered');
  } catch (e: unknown) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'handler registration failed');
    process.exit(1);
  }

  log.info('worker ready');

  // Signal handlers AFTER boss + handlers are live, so a SIGTERM during
  // boot doesn't try to stop a boss that never started. The shutdown
  // sequence is: fire abort → boss.stop({ graceful, close }) → drain.
  registerSignalHandlers({
    log,
    onShutdown: async (): Promise<void> => {
      shutdownController.abort();
      try {
        // graceful=true waits for active jobs; close=true closes the
        // pg-boss pool. We accept a brief wait — Railway gives 10s by
        // default which our SHUTDOWN_DRAIN_MS + pg-boss internal stop
        // fits comfortably under.
        await boss.stop({ graceful: true, close: true });
        log.info('pg-boss stopped');
      } catch (e: unknown) {
        log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'pg-boss stop failed');
      }
    },
    drainMs: SHUTDOWN_DRAIN_MS,
  });
  registerCrashHandlers({ log });
}

main().catch((e: unknown) => {
  log.fatal({ err: e instanceof Error ? e.message : 'unknown' }, 'worker boot failed');
  process.exit(1);
});
