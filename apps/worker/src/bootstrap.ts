/**
 * Worker bootstrap — extracted from main.ts so it's directly testable
 * (Single Responsibility refactor: signal handling, DB smoke-test, and
 * the runtime loop are now separate exports). The original main.ts
 * combined all three into a single async function, which made unit
 * testing impossible without spawning a child process.
 *
 * Each function returns a clear effect or a clear error — callers
 * compose them in production (main.ts) and in tests (with mocks).
 */
/** Minimal `Pool` shape we need — typed structurally so we don't take
 *  a direct `pg` dep in this package (the dep is owned by @emapp/db). */
export interface PoolLike {
  connect(): Promise<{
    query<T>(text: string): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

export interface BootLogger {
  info(meta: Record<string, unknown> | string, msg?: string): void;
  error(meta: Record<string, unknown> | string, msg?: string): void;
  fatal(meta: Record<string, unknown> | string, msg?: string): void;
}

/** Verify the DB pool can answer a trivial query. Throws on any
 *  failure so the caller decides whether to exit non-zero (production)
 *  or assert (tests). */
export async function smokeTestDb(pool: PoolLike): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ ok: number }>('SELECT 1 AS ok');
    const ok = res.rows[0]?.ok;
    if (ok !== 1) {
      throw new Error('SELECT 1 returned unexpected value');
    }
  } finally {
    client.release();
  }
}

/** A graceful-shutdown coordinator. Registers handlers for SIGTERM /
 *  SIGINT that call `onShutdown` exactly once, then exit after a
 *  drain window. Returns the same `shutdown` function for direct
 *  invocation in tests. */
export function registerSignalHandlers(opts: {
  log: BootLogger;
  onShutdown: () => Promise<void> | void;
  drainMs: number;
  /** Override `process.exit` so tests can capture exit codes
   *  without actually terminating the test runner. Default = real
   *  process.exit. */
  exit?: (code: number) => void;
}): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    opts.log.info({ signal }, 'shutdown requested');
    try {
      await opts.onShutdown();
    } catch (e: unknown) {
      opts.log.error(
        { err: e instanceof Error ? e.message : 'unknown' },
        'onShutdown threw — exiting anyway',
      );
    }
    // Drain window — lets pino flush + pg-boss finalize in-flight.
    await new Promise((r) => setTimeout(r, opts.drainMs));
    opts.log.info('worker exiting');
    exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  return shutdown;
}

/** Register process-level safety net for application-layer errors
 *  not caught by the per-client pg guard (D.29). Logs + exits
 *  non-zero so Railway restarts the worker. */
export function registerCrashHandlers(opts: {
  log: BootLogger;
  exit?: (code: number) => void;
}): void {
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  process.on('uncaughtException', (err: Error) => {
    opts.log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — exiting');
    exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    opts.log.fatal({ reason: String(reason) }, 'unhandledRejection — exiting');
    exit(1);
  });
}
