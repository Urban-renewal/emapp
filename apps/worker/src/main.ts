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
 *
 * Operational contract (per docs/07 §13 incident response):
 *  - Logs structured JSON via pino (parsable in Railway / Sentry).
 *  - SIGTERM = graceful drain (placeholder; S2 will wire pg-boss.stop).
 *  - Process MUST exit non-zero on unrecoverable error so Railway
 *    restarts it. Verified by the resilient pg pool work (D.29).
 *
 * Refactor (audit-pass pre-S2): the smoke-test, signal-handlers, and
 * crash-handlers were extracted to `./bootstrap.ts` so they're each
 * unit-testable in isolation. `main.ts` is now the composition root —
 * it wires real `process.exit` + real `pool` and runs the smoke-test.
 */
import { pool } from '@emapp/db';
// eslint-disable-next-line import/no-named-as-default
import pino from 'pino';

import { registerCrashHandlers, registerSignalHandlers, smokeTestDb } from './bootstrap';

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'emapp-worker' },
});

/** Drain window before exit. 250ms is enough for pino to flush and for
 *  S2's pg-boss `stop()` to finalize in-flight jobs. Tunable when we
 *  see real prod behaviour. */
const SHUTDOWN_DRAIN_MS = 250;

async function main(): Promise<void> {
  log.info('worker booting');

  try {
    await smokeTestDb(pool);
    log.info('db connectivity OK');
  } catch (e: unknown) {
    log.error({ err: e instanceof Error ? e.message : 'unknown' }, 'db smoke-test failed');
    process.exit(1);
  }

  // pg-boss subscription lands in S2. For S1.5 the worker just sits
  // idle so the Railway service stays up.
  log.info('worker ready (S1.5 skeleton — no queue subscription yet)');

  // Wire signal handlers AFTER the smoke-test passes — so a failure
  // during boot doesn't get masked by SIGTERM cleanup.
  registerSignalHandlers({
    log,
    onShutdown: async (): Promise<void> => {
      // S2 will call boss.stop() here. For S1.5 nothing to drain.
    },
    drainMs: SHUTDOWN_DRAIN_MS,
  });
  registerCrashHandlers({ log });
}

main().catch((e: unknown) => {
  log.fatal({ err: e instanceof Error ? e.message : 'unknown' }, 'worker boot failed');
  process.exit(1);
});
