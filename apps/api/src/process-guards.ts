import { closeAllPools } from '@emapp/db';
import type { INestApplication } from '@nestjs/common';
import * as Sentry from '@sentry/node';

// Known-safe error codes — surface they raise is bounded to a single
// torn-down socket; the rest of the process state is still trustworthy,
// so we log and survive instead of restarting.
const SAFE_UNCAUGHT_CODES = new Set(['EPIPE', 'ECONNRESET']);

interface ErrnoLike {
  code?: string;
}

export interface InstallOptions {
  app?: Pick<INestApplication, 'close'>;
  exit?: (code: number) => void;
  // Test seam — when false, an "unknown" uncaughtException logs but does
  // not call exit, so the test process is not torn down.
  exitOnUncaught?: boolean;
}

export interface ProcessGuardHandles {
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: Error) => void;
  onSigterm: () => void;
  onSigint: () => void;
  uninstall: () => void;
}

export function installProcessGuards(opts: InstallOptions = {}): ProcessGuardHandles {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const exitOnUncaught = opts.exitOnUncaught ?? true;
  let shuttingDown = false;

  const onUnhandledRejection = (reason: unknown): void => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`[process] unhandledRejection: ${err.message}\n`);
    try {
      Sentry.captureException(err);
    } catch {
      /* Sentry init failure must never mask the original error */
    }
  };

  const onUncaughtException = (err: Error): void => {
    const code = (err as ErrnoLike).code;
    const safe = code !== undefined && SAFE_UNCAUGHT_CODES.has(code);
    process.stderr.write(
      `[process] uncaughtException${safe ? ` (safe:${code})` : ''}: ${err.message}\n`,
    );
    try {
      Sentry.captureException(err);
    } catch {
      /* see above */
    }
    if (!safe && exitOnUncaught) {
      // State is suspect — Railway will restart cleanly. Surviving with
      // an unknown error in flight is worse than a fresh process.
      exit(1);
    }
  };

  const drainAndExit = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[process] ${signal} received — draining\n`);
    try {
      if (opts.app) {
        await opts.app.close();
      }
      await closeAllPools();
    } catch (err) {
      try {
        Sentry.captureException(err);
      } catch {
        /* swallow */
      }
    } finally {
      exit(0);
    }
  };

  const onSigterm = (): void => {
    void drainAndExit('SIGTERM');
  };
  const onSigint = (): void => {
    void drainAndExit('SIGINT');
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return {
    onUnhandledRejection,
    onUncaughtException,
    onSigterm,
    onSigint,
    uninstall: () => {
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
    },
  };
}
