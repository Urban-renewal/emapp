/**
 * ADVERSARIAL test for the global exception filter (`http-exception.filter.ts`).
 *
 * LOAD-BEARING invariant (security): on a 5xx the CLIENT body must be opaque —
 * exactly `{ error: { code, message: 'Internal server error' } }`. The real
 * exception message, stack, and any pg cause (detail/hint/SQL) must reach ONLY
 * the server logger, NEVER the wire. The `debug` key is attached ONLY under the
 * fail-closed opt-in (`AUTH_DEBUG_ERRORS==='1' && NODE_ENV!=='production'`).
 *
 * Why this is non-vacuous: we build a real Error at runtime whose `.message` is
 * a recognizable marker and attach a pg-style `cause` (code/detail/hint) with
 * its own markers, run the REAL filter against a captured Fastify reply, then
 * assert the SERIALIZED client body does not contain ANY of those markers. If a
 * future edit interpolated `exception.message` (or the cause detail) into the
 * client `message`, the marker would appear in the serialized body and the test
 * would fail.
 *
 * No HTTP / DI — the filter is a pure `@Catch()` class. We hand it a minimal
 * `ArgumentsHost` whose `switchToHttp().getResponse()` returns a fake
 * `FastifyReply` that records the status + sent body.
 */
import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ENV_KEYS = ['AUTH_DEBUG_ERRORS', 'NODE_ENV'] as const;

describe('GlobalExceptionFilter — 5xx opacity', () => {
  let filter: GlobalExceptionFilter;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    vi.restoreAllMocks();
  });

  // ---- TEST 5: 500 is OPAQUE (LOAD-BEARING) — debug flag UNSET ----
  it('5) emits exactly { error: { code, message } } and NO internals when AUTH_DEBUG_ERRORS is unset', () => {
    delete process.env['AUTH_DEBUG_ERRORS'];
    delete process.env['NODE_ENV'];
    // Silence the logger output (we assert ON it in test 7; here just keep it
    // off the test console).
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { exception, msgMarker, detailMarker, hintMarker } = makeLeaky500();
    // Sanity: the fixture really carries the markers (no vacuous assertion).
    expect(exception.message).toContain(msgMarker);

    const { host, sent } = fakeHost();
    filter.catch(exception, host);

    expect(sent.status).toBe(500);
    // Exact shape: code + generic message, nothing else.
    expect(sent.body).toEqual({ error: { code: '500', message: 'Internal server error' } });

    const body = sent.body as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty('debug');
    expect(body.error).not.toHaveProperty('stack');
    expect(body.error).not.toHaveProperty('detail');
    expect(body.error).not.toHaveProperty('hint');

    // The serialized body must not contain ANY marker (message / detail / hint).
    const serialized = JSON.stringify(sent.body);
    expect(serialized, 'exception message must not cross the wire').not.toContain(msgMarker);
    expect(serialized, 'pg detail must not cross the wire').not.toContain(detailMarker);
    expect(serialized, 'pg hint must not cross the wire').not.toContain(hintMarker);
    expect(serialized).not.toContain('23505');
  });

  // ---- TEST 6: PROD FAIL-CLOSED — flag=1 AND prod ⇒ STILL no debug ----
  it('6) refuses the debug key in production even with AUTH_DEBUG_ERRORS=1', () => {
    process.env['AUTH_DEBUG_ERRORS'] = '1';
    process.env['NODE_ENV'] = 'production';
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { exception, msgMarker, detailMarker } = makeLeaky500();
    const { host, sent } = fakeHost();
    filter.catch(exception, host);

    expect(sent.status).toBe(500);
    const body = sent.body as { error: Record<string, unknown> };
    // Fail-closed: prod NEVER attaches debug even with the flag on.
    expect(body.error, 'prod must structurally refuse the debug body').not.toHaveProperty('debug');
    expect(body.error).toEqual({ code: '500', message: 'Internal server error' });

    const serialized = JSON.stringify(sent.body);
    expect(serialized).not.toContain(msgMarker);
    expect(serialized).not.toContain(detailMarker);
  });

  // ---- Positive control: debug DOES attach in dev with the flag on (proves
  //      the gate is real, not a constant-false — so tests 5/6 mean something) ----
  it('6b) DOES attach debug (with the markers) when flag=1 AND not production', () => {
    process.env['AUTH_DEBUG_ERRORS'] = '1';
    delete process.env['NODE_ENV']; // not production
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { exception, msgMarker, detailMarker } = makeLeaky500();
    const { host, sent } = fakeHost();
    filter.catch(exception, host);

    const body = sent.body as { error: { debug?: unknown } };
    expect(body.error).toHaveProperty('debug');
    // The dev debug body intentionally carries the internals — confirming the
    // gate above is the ONLY thing keeping them off the wire in prod/default.
    const serialized = JSON.stringify(sent.body);
    expect(serialized).toContain(msgMarker);
    expect(serialized).toContain(detailMarker);
  });

  // ---- TEST 7: the full detail DOES reach the logger (not lost, just not sent) ----
  it('7) logs the exception message AND the pg cause detail/hint to the server logger', () => {
    delete process.env['AUTH_DEBUG_ERRORS'];
    delete process.env['NODE_ENV'];
    const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { exception, msgMarker, detailMarker, hintMarker } = makeLeaky500();
    const { host } = fakeHost();
    filter.catch(exception, host);

    // Flatten every argument of every logger.error call into one string.
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged, 'exception message must be in the server log').toContain(msgMarker);
    expect(logged, 'pg detail must be in the server log').toContain(detailMarker);
    expect(logged, 'pg hint must be in the server log').toContain(hintMarker);
    expect(logged).toContain('23505');
  });

  // ---- Guard: a 4xx HttpException is NOT treated as a 500 (no generic body) ----
  it('passes a 4xx HttpException through with its status, not a generic 500', () => {
    const { host, sent } = fakeHost();
    const exc = new HttpException({ error: { code: 'invalid_otp', message: 'bad' } }, 401);
    filter.catch(exc, host);
    expect(sent.status).toBe(401);
    // The D.16-shaped body passes through untouched.
    expect(sent.body).toEqual({ error: { code: 'invalid_otp', message: 'bad' } });
  });
});
