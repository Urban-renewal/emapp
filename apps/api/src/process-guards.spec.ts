import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@emapp/db', () => ({
  closeAllPools: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import { installProcessGuards, type ProcessGuardHandles } from './process-guards';

describe('installProcessGuards', () => {
  let handles: ProcessGuardHandles | undefined;
  let baseline: {
    unhandledRejection: number;
    uncaughtException: number;
    SIGTERM: number;
    SIGINT: number;
  };

  beforeEach(() => {
    baseline = {
      unhandledRejection: process.listenerCount('unhandledRejection'),
      uncaughtException: process.listenerCount('uncaughtException'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
    };
  });

  afterEach(() => {
    handles?.uninstall();
    handles = undefined;
    vi.clearAllMocks();
  });

  it('installs one listener on each of the four process events', () => {
    handles = installProcessGuards({ exit: vi.fn(), exitOnUncaught: false });
    expect(process.listenerCount('unhandledRejection')).toBe(baseline.unhandledRejection + 1);
    expect(process.listenerCount('uncaughtException')).toBe(baseline.uncaughtException + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM + 1);
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT + 1);
  });

  it('uninstall() removes every listener it added', () => {
    handles = installProcessGuards({ exit: vi.fn(), exitOnUncaught: false });
    handles.uninstall();
    handles = undefined;
    expect(process.listenerCount('unhandledRejection')).toBe(baseline.unhandledRejection);
    expect(process.listenerCount('uncaughtException')).toBe(baseline.uncaughtException);
    expect(process.listenerCount('SIGTERM')).toBe(baseline.SIGTERM);
    expect(process.listenerCount('SIGINT')).toBe(baseline.SIGINT);
  });

  it('unhandledRejection reports to Sentry and does NOT exit', async () => {
    const Sentry = await import('@sentry/node');
    const exit = vi.fn();
    handles = installProcessGuards({ exit, exitOnUncaught: false });

    handles.onUnhandledRejection(new Error('boom'));

    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('unhandledRejection wraps a non-Error reason without throwing', async () => {
    const Sentry = await import('@sentry/node');
    const exit = vi.fn();
    handles = installProcessGuards({ exit, exitOnUncaught: false });

    expect(() => handles!.onUnhandledRejection('plain string')).not.toThrow();
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('uncaughtException exits(1) on an unknown error', () => {
    const exit = vi.fn();
    handles = installProcessGuards({ exit });

    handles.onUncaughtException(new Error('unknown'));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uncaughtException with code=EPIPE logs but does NOT exit', () => {
    const exit = vi.fn();
    handles = installProcessGuards({ exit });
    const err = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

    handles.onUncaughtException(err);

    expect(exit).not.toHaveBeenCalled();
  });

  it('uncaughtException with code=ECONNRESET logs but does NOT exit', () => {
    const exit = vi.fn();
    handles = installProcessGuards({ exit });
    const err = Object.assign(new Error('peer reset'), { code: 'ECONNRESET' });

    handles.onUncaughtException(err);

    expect(exit).not.toHaveBeenCalled();
  });

  it('SIGTERM closes the app, drains pg pools, and exits(0)', async () => {
    const { closeAllPools } = await import('@emapp/db');
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    handles = installProcessGuards({ app: { close }, exit });

    handles.onSigterm();
    // Drain microtask + the awaited promise chain inside drainAndExit.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeAllPools)).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('SIGINT triggers the same graceful path', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    handles = installProcessGuards({ app: { close }, exit });

    handles.onSigint();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('repeated shutdown signals only drain once', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    handles = installProcessGuards({ app: { close }, exit });

    handles.onSigterm();
    handles.onSigterm();
    handles.onSigint();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
