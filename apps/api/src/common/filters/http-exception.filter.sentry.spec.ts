/**
 * S1 (audit) — the global exception filter must REPORT 5xx faults to Sentry.
 *
 * Today `GlobalExceptionFilter` logs 5xx to the server `Logger` but never calls
 * `Sentry.captureException`, so in-request 500s are invisible in Sentry. We are
 * about to add a Sentry capture on the 5xx branch. This spec PINS the contract
 * for that change and is RED until the impl lands.
 *
 * Contract pinned here:
 *  1. 5xx (thrown non-HttpException Error OR HttpException status>=500) ⇒
 *     `Sentry.captureException` called exactly once with the original exception.
 *  2. 4xx (HttpException 400/403/404, or a carried-status 400 JSON-parser case)
 *     ⇒ `Sentry.captureException` NOT called.
 *  3. PII SAFETY: nothing handed to Sentry (the captured error + any
 *     withScope/setContext/setExtra/setTag payloads) may contain the pg
 *     `cause.detail` / `cause.hint` VALUES — those carry national_id / column
 *     values. We serialize EVERY arg of EVERY Sentry call and assert the
 *     detail/hint markers are absent. (pgcode '23505' and the top-level message
 *     ARE allowed.)
 *  4. The 5xx CLIENT body invariant is unchanged: exactly
 *     `{ error: { code, message: 'Internal server error' } }` (opaque).
 *
 * Harness: mirrors `http-exception.filter.spec.ts` — a `fakeHost()` double that
 * records status+body, running the REAL filter (pure `@Catch()` class, no
 * HTTP/DI). `@sentry/node` is mocked with `vi.fn()` spies (same pattern as
 * `process-guards.spec.ts`). The adversarial `makeLeaky500()` builds an Error
 * whose pg-style `cause` carries detail/hint MARKER strings assembled at
 * runtime, so the PII-absence assertion is non-vacuous.
 */
import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Provide every capture/scope primitive the impl MIGHT use, so it has freedom
// in HOW it reports — our assertions key only on `captureException` being
// called (+ PII absence across ALL recorded calls), not on a specific shape.
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  withScope: vi.fn((cb?: (scope: unknown) => void) => {
    // Run the callback with a recording scope so any setContext/setExtra/setTag
    // the impl performs INSIDE withScope is observable on the module spies.
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

import { GlobalExceptionFilter } from './http-exception.filter';

/** Captured output of a single `reply.status(n).send(body)` chain. */
interface SentReply {
  status: number;
  body: unknown;
}

/** Minimal FastifyReply double: records status + body, supports chaining. */
function fakeHost(): { host: ArgumentsHost; sent: SentReply } {
  const sent: SentReply = { status: 0, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: <T>() => reply as unknown as T,
      getRequest: <T>() => ({}) as T,
    }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

/**
 * Build a non-HttpException 500 with marker strings — assembled at runtime so
 * no marker literal is a committed constant the filter could trivially match.
 */
function makeLeaky500(): {
  exception: Error;
  msgMarker: string;
  detailMarker: string;
  hintMarker: string;
} {
  const msgMarker = `DB-INTERNAL-LEAK-${(424_242).toString()}`;
  const detailMarker = `PG-DETAIL-national_id-${(777).toString()}`;
  const hintMarker = `PG-HINT-check-constraint-${(888).toString()}`;
  const exception = new Error(msgMarker);
  // pg-style cause chain (what node-postgres attaches): code/detail/hint.
  (exception as { cause?: unknown }).cause = {
    message: 'duplicate key value violates unique constraint',
    code: '23505',
    detail: detailMarker,
    hint: hintMarker,
  };
  return { exception, msgMarker, detailMarker, hintMarker };
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
 * leaked `cause.detail` on the captured error is actually visible to the
 * marker assertion. Functions (e.g. the withScope callback) are skipped.
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
    // Error own-enumerable props don't include message/stack/cause — pull them.
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

describe('GlobalExceptionFilter — S1: 5xx Sentry capture', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    // Silence the server logger — test 7 in the sibling spec asserts on it;
    // here we only care about the Sentry seam + the client body.
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ---- (1) 5xx non-HttpException Error ⇒ captureException once, with the error ----
  it('reports a thrown non-HttpException Error (500) to Sentry exactly once with the original exception', () => {
    const { exception } = makeLeaky500();
    const { host, sent } = fakeHost();

    filter.catch(exception, host);

    expect(sent.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // The ORIGINAL exception object (so Sentry gets the real stack/grouping).
    expect(Sentry.captureException).toHaveBeenCalledWith(exception, expect.anything());
  });

  // ---- (1b) HttpException with status>=500 is ALSO a 5xx ⇒ captured ----
  it('reports an HttpException with status 503 to Sentry exactly once', () => {
    const exc = new HttpException({ error: { code: 'upstream', message: 'down' } }, 503);
    const { host, sent } = fakeHost();

    filter.catch(exc, host);

    expect(sent.status).toBe(503);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(exc, expect.anything());
  });

  // ---- (2) 4xx HttpExceptions are client errors ⇒ NOT captured ----
  it.each([
    [400, 'bad_request'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ])('does NOT report a %d HttpException to Sentry', (status, code) => {
    const exc = new HttpException({ error: { code, message: 'client' } }, status);
    const { host, sent } = fakeHost();

    filter.catch(exc, host);

    expect(sent.status).toBe(status);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ---- (2b) carried-status 400 (JSON-parser convention) ⇒ NOT captured ----
  it('does NOT report a carried-status 400 (invalid_json parser case) to Sentry', () => {
    // Non-HttpException carrying statusCode=400 + code 'invalid_json' — the
    // filter treats this as a CLIENT 4xx, so it must not page Sentry.
    const exc = Object.assign(new Error('Unexpected token in JSON'), {
      statusCode: 400,
      code: 'invalid_json',
    });
    const { host, sent } = fakeHost();

    filter.catch(exc, host);

    expect(sent.status).toBe(400);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ---- (3) PII SAFETY — the critical assertion: detail/hint must be scrubbed ----
  it('never hands the pg cause detail/hint VALUES to Sentry on a 5xx (PII scrub)', () => {
    const { exception, msgMarker, detailMarker, hintMarker } = makeLeaky500();
    // Sanity: the fixture really carries the markers (non-vacuous).
    expect((exception as { cause?: { detail?: string } }).cause?.detail).toBe(detailMarker);

    const { host } = fakeHost();
    filter.catch(exception, host);

    // It MUST have reported (otherwise this assertion would be vacuously green).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const serialized = serializeAllSentryArgs();
    // pgcode + top-level message are allowed; ONLY detail/hint VALUES are PII.
    expect(serialized, 'pg cause detail must NOT reach Sentry').not.toContain(detailMarker);
    expect(serialized, 'pg cause hint must NOT reach Sentry').not.toContain(hintMarker);
    // Confirm the serializer actually sees SOMETHING from the capture (so the
    // two negative assertions above aren't passing because the walker is blind).
    expect(serialized.length, 'serializer must observe the Sentry payload').toBeGreaterThan(0);
    expect(serialized, 'sanity: top-level message IS forwarded and visible').toContain(msgMarker);
  });

  // ---- (4) CLIENT body invariant unchanged with the capture added ----
  it('keeps the 5xx client body opaque ({ error: { code, message } }) alongside the capture', () => {
    delete process.env['AUTH_DEBUG_ERRORS'];
    const { exception, msgMarker, detailMarker, hintMarker } = makeLeaky500();
    const { host, sent } = fakeHost();

    filter.catch(exception, host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: { code: '500', message: 'Internal server error' } });

    const body = sent.body as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('debug');
    expect(body.error).not.toHaveProperty('detail');
    expect(body.error).not.toHaveProperty('hint');

    const serialized = JSON.stringify(sent.body);
    expect(serialized).not.toContain(msgMarker);
    expect(serialized).not.toContain(detailMarker);
    expect(serialized).not.toContain(hintMarker);
    expect(serialized).not.toContain('23505');
  });
});
