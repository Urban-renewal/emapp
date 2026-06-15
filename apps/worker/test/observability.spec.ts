/**
 * Audit slice S2 (observability) — the worker has NO real Sentry capture.
 *
 * Today every "Sentry" reference in apps/worker is a COMMENT assuming Railway
 * forwards logs. So when an import/reaper/signature-expiry job throws, or the
 * process crashes (uncaughtException / unhandledRejection), the failure is
 * INVISIBLE in Sentry. We are about to add:
 *
 *   1. `apps/worker/src/observability.ts` exporting
 *      `captureWorkerException(err, { jobName?, jobId?, attempt? })` — scrubs
 *      pg `cause.detail` / `cause.hint` VALUES (PII: column values like
 *      `Key (national_id)=(123456789) ...`) IN PLACE down the cause chain
 *      (depth-bounded), then calls Sentry.captureException with level/tags/
 *      contexts. pgcode + top-level message ARE allowed; detail/hint are NOT.
 *   2. `apps/worker/src/instrument.ts` — DSN-gated Sentry.init on
 *      SENTRY_DSN_WORKER (mirrors apps/api/src/instrument.ts on SENTRY_DSN_API).
 *   3. `registerCrashHandlers` in `apps/worker/src/bootstrap.ts` — gains an
 *      optional `capture?` param (default captureWorkerException) and calls
 *      `capture(err)` BEFORE `exit(1)` on BOTH uncaughtException and
 *      unhandledRejection.
 *   4. The pg-boss job wrapper in `apps/worker/src/pg-boss-adapter.ts` — the
 *      handler-error `catch` calls `captureWorkerException(err, {...})` BEFORE
 *      rethrowing (retryable AND non-retryable paths).
 *
 * These specs PIN that contract and are RED until the impl lands.
 *
 * Mock shape + PII-absence technique mirror
 * apps/api/src/common/filters/http-exception.filter.sentry.spec.ts:
 * `@sentry/node` mocked with vi.fn() spies; `makeLeaky500()` assembles the
 * detail/hint MARKER strings at runtime (no committed literal the impl could
 * trivially match); `serializeAllSentryArgs()` walks Error objects explicitly
 * (JSON.stringify(new Error()) is '{}') so a leaked cause.detail is visible to
 * the assertion.
 */
import { NonRetryableJobError, type IJobHandler } from '@emapp/jobs';
import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Provide every capture/scope primitive the impl MIGHT use, plus `init` (for
// the instrument gating test). Our assertions key only on `captureException` /
// `init` being called (+ PII absence across ALL recorded calls), not on a
// specific scope shape.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((cb?: (scope: unknown) => void) => {
    const scope = {
      setContext: (Sentry as unknown as { setContext: unknown }).setContext,
      setExtra: (Sentry as unknown as { setExtra: unknown }).setExtra,
      setExtras: (Sentry as unknown as { setExtras: unknown }).setExtras,
      setTag: (Sentry as unknown as { setTag: unknown }).setTag,
      setTags: (Sentry as unknown as { setTags: unknown }).setTags,
      setLevel: (Sentry as unknown as { setLevel: unknown }).setLevel,
      setFingerprint: (Sentry as unknown as { setFingerprint: unknown }).setFingerprint,
    };
    cb?.(scope);
  }),
  setContext: vi.fn(),
  setExtra: vi.fn(),
  setExtras: vi.fn(),
  setTag: vi.fn(),
  setTags: vi.fn(),
  setLevel: vi.fn(),
  setFingerprint: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import { registerCrashHandlers } from '../src/bootstrap';
import { captureWorkerException } from '../src/observability';
import { registerHandler, type BossLike } from '../src/pg-boss-adapter';

/**
 * Build a pg-style error whose `cause` chain carries detail/hint MARKER
 * strings assembled at runtime — so the PII-absence assertions are
 * non-vacuous. Two levels deep to exercise the cause-walk.
 */
function makeLeakyPgError(): {
  exception: Error;
  msgMarker: string;
  pgcode: string;
  detailMarker: string;
  hintMarker: string;
  detailMarker2: string;
  hintMarker2: string;
} {
  const msgMarker = `WORKER-DB-LEAK-${(515_151).toString()}`;
  const pgcode = '23505';
  const detailMarker = `PG-DETAIL-national_id-${(123_456_789).toString()}`;
  const hintMarker = `PG-HINT-check-constraint-${(999).toString()}`;
  const detailMarker2 = `PG-DETAIL-phone-${(555_123).toString()}`;
  const hintMarker2 = `PG-HINT-nested-${(111).toString()}`;
  const exception = new Error(msgMarker);
  // pg-style cause chain (what node-postgres attaches): code/detail/hint,
  // nested one more level to prove the walk is depth-aware.
  (exception as { cause?: unknown }).cause = {
    message: 'duplicate key value violates unique constraint',
    code: pgcode,
    detail: detailMarker,
    hint: hintMarker,
    cause: {
      message: 'nested pg cause',
      code: '23503',
      detail: detailMarker2,
      hint: hintMarker2,
    },
  };
  return { exception, msgMarker, pgcode, detailMarker, hintMarker, detailMarker2, hintMarker2 };
}

/** Every Sentry spy whose args could carry forwarded data we must scrub. */
const SENTRY_SPIES = [
  'captureException',
  'withScope',
  'setContext',
  'setExtra',
  'setExtras',
  'setTag',
  'setTags',
  'setLevel',
  'setFingerprint',
  'addBreadcrumb',
] as const;

/**
 * Serialize the arguments of EVERY recorded Sentry call into one string. We
 * walk Error objects explicitly (JSON.stringify(new Error()) is '{}') so a
 * leaked `cause.detail` on the captured error is visible to the marker
 * assertion. Functions (e.g. the withScope callback) are skipped.
 */
function serializeAllSentryArgs(): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'function') return;
    if (typeof v !== 'object') {
      parts.push(String(v));
      return;
    }
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (v instanceof Error) {
      parts.push(v.message, v.stack ?? '');
      walk((v as { cause?: unknown }).cause);
    }
    for (const key of Object.keys(obj)) {
      parts.push(key);
      walk(obj[key]);
    }
  };

  for (const name of SENTRY_SPIES) {
    const spy = (Sentry as unknown as Record<string, { mock?: { calls: unknown[][] } }>)[name];
    if (!spy?.mock) continue;
    for (const call of spy.mock.calls) {
      for (const arg of call) walk(arg);
    }
  }
  return parts.join(' ');
}

afterEach(() => {
  vi.clearAllMocks();
});

// ───────────────────────── (a) captureWorkerException ─────────────────────────

describe('S2 · captureWorkerException — PII-safe Sentry capture', () => {
  it('reports a pg-style error to Sentry exactly once', () => {
    const { exception } = makeLeakyPgError();
    captureWorkerException(exception, { jobName: 'import', jobId: 'job-1', attempt: 1 });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // The ORIGINAL exception object (so Sentry gets the real stack/grouping).
    expect(Sentry.captureException).toHaveBeenCalledWith(exception, expect.anything());
  });

  it('never hands the pg cause detail/hint VALUES to Sentry (PII scrub, depth-aware)', () => {
    const { exception, msgMarker, pgcode, detailMarker, hintMarker, detailMarker2, hintMarker2 } =
      makeLeakyPgError();
    // Sanity: the fixture really carries the markers (non-vacuous).
    expect((exception as { cause?: { detail?: string } }).cause?.detail).toBe(detailMarker);

    captureWorkerException(exception, { jobName: 'import', jobId: 'job-1', attempt: 1 });

    // It MUST have reported (otherwise the absence assertions are vacuous).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const serialized = serializeAllSentryArgs();
    // ONLY detail/hint VALUES are PII — at every depth of the cause chain.
    expect(serialized, 'pg cause detail must NOT reach Sentry').not.toContain(detailMarker);
    expect(serialized, 'pg cause hint must NOT reach Sentry').not.toContain(hintMarker);
    expect(serialized, 'nested pg cause detail must NOT reach Sentry').not.toContain(detailMarker2);
    expect(serialized, 'nested pg cause hint must NOT reach Sentry').not.toContain(hintMarker2);
    // Non-vacuous: the serializer DID observe the capture payload, and the
    // pgcode + top-level message (which ARE allowed) are present.
    expect(serialized.length, 'serializer must observe the Sentry payload').toBeGreaterThan(0);
    expect(serialized, 'top-level message IS forwarded').toContain(msgMarker);
    expect(serialized, 'pgcode IS allowed and forwarded').toContain(pgcode);
  });

  it('forwards the job context (jobName / jobId) to Sentry', () => {
    const { exception } = makeLeakyPgError();
    const jobNameMarker = `JOBNAME-${(424_242).toString()}`;
    const jobIdMarker = `JOBID-${(909_090).toString()}`;
    captureWorkerException(exception, { jobName: jobNameMarker, jobId: jobIdMarker, attempt: 3 });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const serialized = serializeAllSentryArgs();
    expect(serialized, 'jobName tag forwarded').toContain(jobNameMarker);
    expect(serialized, 'jobId tag forwarded').toContain(jobIdMarker);
  });

  it('MUTATES the error in place — scrubs detail/hint off the cause object', () => {
    const { exception } = makeLeakyPgError();
    captureWorkerException(exception, { jobName: 'reaper' });
    const cause = (exception as { cause?: Record<string, unknown> }).cause;
    // The scrub is in-place: after capture, detail/hint are gone from the
    // cause object the worker still holds (defence in depth — nothing
    // downstream can re-leak them either).
    expect(cause).toBeDefined();
    expect(cause).not.toHaveProperty('detail');
    expect(cause).not.toHaveProperty('hint');
    // pgcode survives (allowed for grouping/diagnosis).
    expect(cause?.code).toBe('23505');
  });

  it('NEVER throws when the cause is frozen (delete would throw) — fail-closed, no capture', () => {
    // A frozen `cause` makes `delete c.detail` throw (TypeError, strict mode).
    // captureWorkerException must NOT propagate that (it runs right before the
    // crash exit), AND must NOT capture an error it could not fully scrub
    // (fail-closed on PII — better to lose the Sentry event than leak detail).
    const leak = 'PG-DETAIL-frozen-leak-313131';
    const exception = new Error('frozen-boom');
    (exception as { cause?: unknown }).cause = Object.freeze({
      code: '23505',
      detail: leak,
      hint: 'H',
    });

    expect(() => captureWorkerException(exception, { jobName: 'import' })).not.toThrow();
    expect(
      Sentry.captureException,
      'fail-closed: no capture when scrub cannot complete',
    ).not.toHaveBeenCalled();
    expect(serializeAllSentryArgs()).not.toContain(leak);
  });
});

// ───────────────────────── (b) registerCrashHandlers ─────────────────────────

describe('S2 · registerCrashHandlers — capture before exit(1)', () => {
  let signalListeners: Map<string, Array<(...args: unknown[]) => void>>;
  let processListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    signalListeners = new Map();
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
    for (const h of signalListeners.get(signal) ?? []) h(...args);
  }

  function mockLog() {
    return { info: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  }

  it('calls the injected capture with the error, then exit(1) on uncaughtException', () => {
    const log = mockLog();
    const exit = vi.fn();
    const capture = vi.fn();
    registerCrashHandlers({ log, exit, capture });

    const err = new Error('uncaught-boom');
    fire('uncaughtException', err);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(err);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('calls the injected capture with the reason, then exit(1) on unhandledRejection', () => {
    const log = mockLog();
    const exit = vi.fn();
    const capture = vi.fn();
    registerCrashHandlers({ log, exit, capture });

    const reason = new Error('rejection-boom');
    fire('unhandledRejection', reason);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(reason);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits(1) even if capture THROWS (observability must never block the crash exit)', () => {
    const log = mockLog();
    const exit = vi.fn();
    const capture = vi.fn(() => {
      throw new Error('sentry-down');
    });
    registerCrashHandlers({ log, exit, capture });

    fire('uncaughtException', new Error('boom'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(exit, 'exit(1) must fire even when capture throws (D.29 restart)').toHaveBeenCalledWith(
      1,
    );

    exit.mockClear();
    capture.mockClear();
    fire('unhandledRejection', new Error('reject-boom'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

// ───────────────────────── (c) pg-boss adapter capture ─────────────────────────

const Payload = z.object({ x: z.number() }).strict();
type Payload = z.infer<typeof Payload>;

function makeHandler(impl: (p: Payload) => Promise<void> = async () => {}): IJobHandler<Payload> & {
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  return {
    name: 'test.job',
    timeoutMs: 5_000,
    maxRetries: 1,
    handle: spy as unknown as IJobHandler<Payload>['handle'],
    spy,
  };
}

interface BossTestState {
  workHandler: ((jobs: { id: string; data: unknown }[]) => Promise<unknown>) | null;
}

function makeBoss(): { boss: BossLike; state: BossTestState } {
  const state: BossTestState = { workHandler: null };
  const boss: BossLike = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async (_name: string, _options, handler) => {
      state.workHandler = handler as typeof state.workHandler;
      return 'worker-test.job';
    }),
  };
  return { boss, state };
}

function mockJobLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('S2 · pg-boss adapter — handler failure is captured to Sentry', () => {
  it('captures a RETRYABLE handler error to Sentry before the error propagates', async () => {
    const { exception } = makeLeakyPgError();
    const { boss, state } = makeBoss();
    const handler = makeHandler(async () => {
      throw exception;
    });
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockJobLog(),
      signal: new AbortController().signal,
    });

    await expect(state.workHandler!([{ id: 'job-7', data: { x: 1 } }])).rejects.toBe(exception);

    // Job failure is now VISIBLE in Sentry (the whole point of S2).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(exception, expect.anything());
  });

  it('captures a NON-RETRYABLE handler error to Sentry too', async () => {
    const { boss, state } = makeBoss();
    const nonRetryable = new NonRetryableJobError('bad file', 'invalid_file');
    const handler = makeHandler(async () => {
      throw nonRetryable;
    });
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockJobLog(),
      signal: new AbortController().signal,
    });

    await expect(state.workHandler!([{ id: 'job-8', data: { x: 1 } }])).rejects.toBe(nonRetryable);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(nonRetryable, expect.anything());
  });

  it('forwards jobId + attempt as context on the handler-error capture', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler(async () => {
      throw new Error('boom-with-context');
    });
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockJobLog(),
      signal: new AbortController().signal,
    });

    // retryCount 2 (0-indexed) → attempt 3; jobId is a unique marker.
    const jobIdMarker = 'job-ctx-636363';
    await expect(
      state.workHandler!([{ id: jobIdMarker, data: { x: 1 }, retryCount: 2 }]),
    ).rejects.toThrow(/boom-with-context/);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const serialized = serializeAllSentryArgs();
    expect(serialized, 'jobId threaded into capture context').toContain(jobIdMarker);
  });
});

// ───────────────────────── (d) instrument — DSN gating ─────────────────────────

describe('S2 · instrument — DSN-gated Sentry.init', () => {
  const ENV_KEY = 'SENTRY_DSN_WORKER';
  let savedDsn: string | undefined;

  beforeEach(() => {
    savedDsn = process.env[ENV_KEY];
    vi.resetModules();
  });

  afterEach(() => {
    if (savedDsn === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedDsn;
    vi.resetModules();
  });

  it('does NOT call Sentry.init when SENTRY_DSN_WORKER is unset', async () => {
    delete process.env[ENV_KEY];
    const sentry = (await import('@sentry/node')) as unknown as {
      init: ReturnType<typeof vi.fn>;
    };
    sentry.init.mockClear();

    await import('../src/instrument');

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it('calls Sentry.init once with the dsn when SENTRY_DSN_WORKER is set', async () => {
    const dsnMarker = 'https://worker-dsn-787878@o0.ingest.sentry.io/1';
    process.env[ENV_KEY] = dsnMarker;
    const sentry = (await import('@sentry/node')) as unknown as {
      init: ReturnType<typeof vi.fn>;
    };
    sentry.init.mockClear();

    await import('../src/instrument');

    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: dsnMarker }));
  });
});
