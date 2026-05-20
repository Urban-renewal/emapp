/**
 * EMAPP worker — process entry.
 *
 * Phase 6 S1.5 (this commit): minimal skeleton that boots, validates
 * env + DB connectivity, logs "worker ready", and stays alive waiting
 * for SIGTERM/SIGINT. No queue subscription yet — that lands in S2
 * when pg-boss is wired.
 *
 * Architecture (locked):
 *  - Separate Railway service from @emapp/api (docs/02 §354 + docs/03
 *    §1424). Same package-tree, different process boundary → different
 *    crash surface, different IAM/secrets scope (R2 write here, not in
 *    API), independent scaling.
 *  - Reads secrets from the same Infisical env as the API. The
 *    @emapp/config `serverEnv` schema is shared, so adding a worker-
 *    only env var (e.g. WORKER_CONCURRENCY) is a single-file change
 *    when S2 lands.
 *
 * Operational contract (per docs/07 §13 incident response):
 *  - Logs structured JSON via pino (parsable in Railway / Sentry).
 *  - SIGTERM = graceful drain (finish current job batch, then exit).
 *    Implemented placeholder here; S2 will wire pg-boss `stop()`.
 *  - Process MUST exit non-zero on unrecoverable error so Railway
 *    restarts it. Verified by the resilient pg pool work (D.29).
 */
import { pool } from '@emapp/db';
// eslint-disable-next-line import/no-named-as-default
import pino from 'pino';

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'emapp-worker' },
});

let shuttingDown = false;

async function main(): Promise<void> {
  log.info('worker booting');

  // Smoke-test the DB connection. This is the same `pool` the API uses
  // (D.21 — domain DB is the only path). A failure here means the
  // worker should crash so Railway restarts it (D.29 resilience).
  try {
    const client = await pool.connect();
    try {
      const res = await client.query<{ ok: number }>('SELECT 1 AS ok');
      const ok = res.rows[0]?.ok;
      if (ok !== 1) throw new Error('SELECT 1 returned unexpected value');
      log.info('db connectivity OK');
    } finally {
      client.release();
    }
  } catch (e: unknown) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'db smoke-test failed');
    process.exit(1);
  }

  // pg-boss + queue subscription land in S2. For S1.5 the worker just
  // sits idle so the Railway service stays up.
  log.info('worker ready (S1.5 skeleton — no queue subscription yet)');

  // Graceful shutdown — Railway sends SIGTERM, gives ~10s before SIGKILL.
  // S2 will replace the no-op with pg-boss.stop() + an in-flight drain.
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown requested');
    // Allow log flush + future drain. Exit after a short window.
    setTimeout(() => {
      log.info('worker exiting');
      process.exit(0);
    }, 250);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Safety net for unhandled errors. D.29 pinned that the pg pool has
  // its own per-client guard; this is for application-layer surprises.
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason: String(reason) }, 'unhandledRejection — exiting');
    process.exit(1);
  });
}

main().catch((e: unknown) => {
  log.fatal({ err: e instanceof Error ? e.message : 'unknown' }, 'worker boot failed');
  process.exit(1);
});
