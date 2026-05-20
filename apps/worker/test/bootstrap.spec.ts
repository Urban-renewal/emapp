/**
 * Phase 6 S1.5 — worker bootstrap unit tests.
 *
 * 8 tests pinning the contract that `main.ts` relies on:
 *  1. smokeTestDb resolves OK when pool returns SELECT 1
 *  2. smokeTestDb rejects on pool.connect() failure
 *  3. smokeTestDb rejects when SELECT 1 returns wrong value
 *  4. smokeTestDb releases the client on success
 *  5. smokeTestDb releases the client even when the query throws
 *  6. registerSignalHandlers calls onShutdown exactly once on repeat signals
 *  7. registerSignalHandlers exits 0 after drain window
 *  8. registerCrashHandlers exits 1 on uncaughtException
 *
 * No DB, no signals — pure async logic + mock pool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCrashHandlers, registerSignalHandlers, smokeTestDb } from '../src/bootstrap';

/** Minimal mock matching Pick<Pool, 'connect'> shape. */
type MockClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};
function mockPool(client: MockClient | Error): {
  connect: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn(() => {
      if (client instanceof Error) return Promise.reject(client);
      return Promise.resolve(client);
    }),
  };
}

/** Capture pino-ish log calls without instantiating real pino. */
function mockLog() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('Phase 6 · worker bootstrap', () => {
  let signalListeners: Map<string, Array<(...args: unknown[]) => void>>;
  let processListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    signalListeners = new Map();
    // Intercept process.on so we can fire signals manually in tests
    // WITHOUT actually killing the test runner.
    processListenerSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => void,
    ): NodeJS.Process => {
      const arr = signalListeners.get(event) ?? [];
      arr.push(handler);
      signalListeners.set(event, arr);
      return process;
    }) as never);
  });

  afterEach(() => {
    processListenerSpy.mockRestore();
  });

  function fire(signal: string, ...args: unknown[]): void {
    for (const h of signalListeners.get(signal) ?? []) {
      h(...args);
    }
  }

  // ─── smokeTestDb ──────────────────────────────────────────────

  it('1) smokeTestDb resolves OK when pool returns SELECT 1', async () => {
    const client: MockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
      release: vi.fn(),
    };
    await expect(smokeTestDb(mockPool(client))).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledWith('SELECT 1 AS ok');
  });

  it('2) smokeTestDb rejects on pool.connect() failure', async () => {
    await expect(smokeTestDb(mockPool(new Error('ECONNREFUSED')))).rejects.toThrow(/ECONNREFUSED/);
  });

  it('3) smokeTestDb rejects when SELECT 1 returns wrong value', async () => {
    const client: MockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 42 }] }),
      release: vi.fn(),
    };
    await expect(smokeTestDb(mockPool(client))).rejects.toThrow(/unexpected/i);
  });

  it('4) smokeTestDb releases the client on success', async () => {
    const client: MockClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
      release: vi.fn(),
    };
    await smokeTestDb(mockPool(client));
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('5) smokeTestDb releases the client even when query throws', async () => {
    const client: MockClient = {
      query: vi.fn().mockRejectedValue(new Error('pg blip')),
      release: vi.fn(),
    };
    await expect(smokeTestDb(mockPool(client))).rejects.toThrow(/pg blip/);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // ─── registerSignalHandlers ──────────────────────────────────

  it('6) registerSignalHandlers calls onShutdown EXACTLY ONCE on repeat signals', async () => {
    const log = mockLog();
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    registerSignalHandlers({ log, onShutdown, drainMs: 10, exit });

    // Fire SIGTERM twice in rapid succession — second must be no-op.
    fire('SIGTERM');
    fire('SIGTERM');
    fire('SIGINT'); // even mixed signals — still idempotent

    // Allow microtasks + drain timer to flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('7) registerSignalHandlers exits 0 after drain window', async () => {
    const log = mockLog();
    const exit = vi.fn();
    registerSignalHandlers({
      log,
      onShutdown: () => Promise.resolve(),
      drainMs: 20,
      exit,
    });
    fire('SIGTERM');
    await new Promise((r) => setTimeout(r, 60));
    expect(exit).toHaveBeenCalledWith(0);
  });

  // ─── registerCrashHandlers ───────────────────────────────────

  it('8) registerCrashHandlers exits 1 on uncaughtException', () => {
    const log = mockLog();
    const exit = vi.fn();
    registerCrashHandlers({ log, exit });

    fire('uncaughtException', new Error('boom'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'boom' }),
      'uncaughtException — exiting',
    );
  });
});
