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
import { env, pool, reloadEnv } from '@emapp/db';
import { REAPER_CRON_HOURLY, REAPER_JOB_NAME } from '@emapp/jobs';
// eslint-disable-next-line import/no-named-as-default
import PgBoss from 'pg-boss';
// eslint-disable-next-line import/no-named-as-default
import pino from 'pino';

import { registerCrashHandlers, registerSignalHandlers, smokeTestDb } from './bootstrap';
import { ImportJobHandler } from './handlers/import-job.handler';
import { ReaperHandler } from './handlers/reaper.handler';
import {
  LegacyAliasResolver,
  MappingResolverChain,
  TemplateResolver,
} from './mapping/mapping-resolver';
import { registerHandler, type BossLike } from './pg-boss-adapter';
import { resetStorageProvider, storageProviderFactory } from './storage-provider';

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'emapp-worker' },
  // v8 Sec-16 — defense-in-depth PII redaction. The handler is
  // careful not to log row content, but a future change that logs a
  // payload field (e.g. for a debug breakpoint) would otherwise leak
  // PII to the worker log. Mirrors the API's pino redact list.
  // `*.*` syntax catches any nesting depth; pino's path matcher
  // walks both arrays and objects.
  redact: {
    paths: [
      '*.national_id',
      '*.nationalId',
      '*.phone',
      '*.password',
      '*.signature',
      '*.signatureBlob',
      '*.pii',
      // The Excel parsed row arrays — if anyone ever logs a row,
      // its cells contain PII.
      '*.row',
      '*.rows',
      // Nested via headers metadata.
      'parsed.row',
      'parsed.rows',
    ],
    remove: true,
  },
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

  // Construct pg-boss. Three notes:
  //  - We pass connectionString (NOT the existing `pool`) so pg-boss
  //    owns its own pg client. That's the supported v10 pattern; sharing
  //    a Pool requires the `db` option with a custom executeSql adapter
  //    and isn't necessary for our scale.
  //  - We use PROVIDER_DATABASE_URL (the BYPASSRLS owner role). Audit-
  //    pass v2 finding C7 (MEDIUM): pg-boss with `migrate:true` (the
  //    default, kept here) needs CREATE on the database to provision
  //    its own schema + tables on first start. Granting CREATE to
  //    app_user (the RLS-restricted application role used by every
  //    withTenant call) is a least-privilege violation — app_user
  //    must only be able to SELECT/INSERT/UPDATE its own domain
  //    tables. The provider role is already authorised for DDL (it
  //    owns the migrations) and is the right principal for the queue
  //    plumbing. Falls back to DATABASE_URL for dev environments that
  //    haven't set PROVIDER_DATABASE_URL — see @emapp/db env defaults.
  //  - migrate:true (default) lets pg-boss apply its own schema on
  //    first start. Idempotent; safe to leave on in prod.
  const boss = new PgBoss({
    connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
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
  // Storage provider is constructed BEFORE the handler so a missing
  // R2 config in production fails the boot here (D.28 governed).
  const storage = storageProviderFactory();
  // Phase 7 — production resolver chain composition. Order matters:
  //   L2 TemplateResolver (org-saved mappings, manager-approved) FIRST,
  //   so a Manager's existing template wins over a generic alias guess.
  //   L1 LegacyAliasResolver (deterministic alias table) SECOND, as
  //   the safety net for files that match canonical aliases without a
  //   saved template (the ~80% common-case).
  //   L3 AgentResolver — Phase 7+; not yet implemented. When it
  //   lands, it composes AFTER L1 (lowest priority — only when both
  //   the manager's library AND the alias table miss).
  // D.34 layered seam — the handler holds the chain via constructor
  // DI so tests can inject a Fake.
  const mappingResolver = new MappingResolverChain([
    new TemplateResolver(),
    new LegacyAliasResolver(),
  ]);
  const importHandler = new ImportJobHandler(storage, mappingResolver);
  try {
    // v8 Perf-4: worker concurrency from env. Default 2 (calibrated:
    //   - Excel parse RAM ≈ 150MB worst-case per concurrent import
    //     (50MB zip × 2-3× decompression × ExcelJS overhead, see
    //     zip-preflight.ts:43-54).
    //   - Railway Free Tier RSS budget ≈ 512MB; baseline (node + pg
    //     pool + pino + handler code) ≈ 100-150MB.
    //   - 2 concurrent imports = ~150MB × 2 + 150MB baseline ≈ 450MB,
    //     fits with headroom.
    // Ops can bump WORKER_CONCURRENCY to 4 on the paid plan (>1GB
    // RSS). Going past 2 on Free Tier risks OOMKill — keep the
    // default conservative.
    const workerConcurrency = Number.parseInt(process.env['WORKER_CONCURRENCY'] ?? '2', 10);
    if (!Number.isFinite(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 16) {
      log.error(
        { value: process.env['WORKER_CONCURRENCY'] },
        'WORKER_CONCURRENCY must be an integer in [1, 16]',
      );
      process.exit(1);
    }
    log.info({ workerConcurrency }, 'registering handler with concurrency');
    await registerHandler({
      // pg-boss v10's class shape is compatible with BossLike (we only
      // touch the four methods declared on the interface).
      boss: boss as unknown as BossLike,
      registration: {
        handler: importHandler,
        payloadSchema: importHandler.payloadSchema,
      },
      concurrency: workerConcurrency,
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

  // Phase 3 #5a — periodic-runner infrastructure + first consumer.
  // Two steps, both idempotent across deploys:
  //   1. registerHandler() — createQueue(reaper:expired-rows) + work():
  //      the CONSUMER side. pg-boss requires the queue to exist before a
  //      schedule can target it (the schedule row FKs to the queue).
  //   2. boss.schedule(name, cron) — the PRODUCER side: pg-boss's own
  //      cron timekeeper (enabled by default in v10) sends an empty-
  //      payload job to that queue on every cron fire. Re-scheduling an
  //      existing name UPSERTs the cron, so a redeploy with a changed
  //      cadence just updates the row — no duplicate schedules.
  // Concurrency 1: a single hourly maintenance tick needs no parallelism,
  // and keeping it serial means two overlapping ticks can never race on
  // the same DELETE.
  const reaperHandler = new ReaperHandler();
  try {
    await registerHandler({
      boss: boss as unknown as BossLike,
      registration: {
        handler: reaperHandler,
        payloadSchema: reaperHandler.payloadSchema,
      },
      concurrency: 1,
      log: {
        info: (msg, meta) => log.info(meta ?? {}, msg),
        warn: (msg, meta) => log.warn(meta ?? {}, msg),
        error: (msg, meta) => log.error(meta ?? {}, msg),
      },
      signal: shutdownController.signal,
    });
    await boss.schedule(REAPER_JOB_NAME, REAPER_CRON_HOURLY);
    log.info({ name: reaperHandler.name, cron: REAPER_CRON_HOURLY }, 'reaper scheduled');
  } catch (e: unknown) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'reaper registration failed');
    process.exit(1);
  }

  log.info('worker ready');

  // v8 §v7-C — SIGHUP credential reload (mirror of API main.ts). Re-
  // reads process.env into @emapp/db's env object and drops the
  // worker's storage provider singleton so the next R2 fetch uses
  // rotated credentials. The worker process keeps running; in-flight
  // jobs keep their current S3Client (rotation window is sub-second
  // so this is acceptable). Logs only the KEYS that changed, never
  // the values.
  process.on('SIGHUP', () => {
    try {
      const changed = reloadEnv();
      resetStorageProvider();
      log.warn(
        { changed_keys: changed },
        'SIGHUP: env reloaded; storage provider singleton dropped',
      );
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'SIGHUP: reload failed');
    }
  });

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
