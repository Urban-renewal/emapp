/**
 * AUDIT — adversarial tests for the browser-side API client.
 *
 * Written from a hostile-reviewer stance: the client wraps `fetch`,
 * unwraps the D.16 envelope, and dispatches an `emapp:unauthenticated`
 * event on 401. Each test below is a probe meant to BREAK an
 * assumption. Tests that mark `it.fails(...)` indicate a CURRENTLY
 * OPEN bug — the agent that closes the bug must flip the marker.
 *
 * Scope:
 *   - Envelope shape: server returns garbage / malicious shapes
 *   - 401 event: only fires once, only in the browser
 *   - 401 distinction: token_expired vs invalid_token (D.31 G2)
 *   - Network failure modes: aborted, non-JSON, empty body
 *   - Header passthrough (Content-Type, custom Idempotency-Key)
 *   - Method coverage for state-changing verbs
 *   - Defense-in-depth: untrusted envelope structure
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiClient, isList, isOk, UNAUTHENTICATED_EVENT } from './api-client';

interface StubResponse {
  status: number;
  body?: unknown;
  bodyText?: string;
  bodyError?: Error;
}

function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse) {
  return vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    const text = r.bodyText ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => {
        if (r.bodyError) return Promise.reject(r.bodyError);
        if (text === '') return Promise.reject(new Error('invalid json'));
        return Promise.resolve(JSON.parse(text));
      },
    } as unknown as Response);
  });
}

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;
let dispatchedEvents: string[] = [];

beforeEach(() => {
  dispatchedEvents = [];
  // Build a window stub that records dispatched events.
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (ev: Event) => {
      dispatchedEvents.push(ev.type);
      return true;
    },
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe('api-client envelope handling — adversarial', () => {
  it('A1) server returns { foo: "bar" } (neither data nor error) — folded to invalid_response (CLOSED §v9-H-7)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { foo: 'bar' },
    })) as unknown as typeof fetch;
    const res = await apiClient.get<unknown>('/anything');
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe('invalid_response');
  });

  it('A2) defensive envelope guard rejects non-D.16 shapes (CLOSED §v9-H-7 — folds to invalid_response)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 200,
      body: { foo: 'bar' },
    })) as unknown as typeof fetch;
    const res = await apiClient.get<unknown>('/anything');
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe('invalid_response');
  });

  it('A3) malformed JSON → folded into invalid_response envelope', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 500,
      bodyText: '<html>500</html>',
    })) as unknown as typeof fetch;
    const res = await apiClient.get<unknown>('/x');
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe('invalid_response');
  });

  it('A4) empty body (204 No Content) → invalid_response envelope (and the call site for DELETE handles this)', async () => {
    globalThis.fetch = stubFetch(() => ({ status: 204, bodyText: '' })) as unknown as typeof fetch;
    const res = await apiClient.delete<unknown>('/x');
    // Today: empty body throws on .json() → caught → invalid_response.
    // The DELETE call site SHOULD treat this as success. Verifies the
    // intentional contract between api-client and call sites.
    if (!isOk(res)) expect(res.error.code).toBe('invalid_response');
  });

  it('A5) network throw during fetch propagates (not swallowed)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    await expect(apiClient.get('/x')).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('api-client 401 handling — adversarial', () => {
  it('A6) 401 dispatches the UNAUTHENTICATED_EVENT EXACTLY ONCE', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 401,
      body: { error: { code: 'invalid_token' } },
    })) as unknown as typeof fetch;
    await apiClient.get<unknown>('/me');
    expect(dispatchedEvents.filter((e) => e === UNAUTHENTICATED_EVENT)).toHaveLength(1);
  });

  it('A7) 401 with code=token_expired triggers silent refresh (CLOSED §v9-P0-4); when refresh succeeds, NO logout event fires', async () => {
    // refresh succeeds (first call to /auth/refresh returns 200), then
    // the replay of /projects also returns 200.
    let callCount = 0;
    globalThis.fetch = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        // The original /projects call → 401 token_expired
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'token_expired' } }),
        } as unknown as Response);
      }
      if (callCount === 2) {
        // /auth/refresh succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { ok: true } }),
        } as unknown as Response);
      }
      // Replay of /projects succeeds.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    await apiClient.get<unknown>('/projects');
    expect(callCount).toBe(3); // original + refresh + replay
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });

  it('A8) when silent refresh FAILS, the unauthenticated event fires (CLOSED §v9-P0-4)', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'token_expired' } }),
        } as unknown as Response);
      }
      // /auth/refresh fails — refresh token expired / revoked
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'invalid_refresh' } }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    await apiClient.get<unknown>('/projects');
    // The original call's body is the 401 token_expired; after refresh
    // fails we DO emit the event (no replay, no second refresh attempt).
    // The post-refresh fall-through emits the event because the
    // outermost call's response was 401 + token_expired (not in
    // SUPPRESS_EVENT set).
    expect(dispatchedEvents).toContain(UNAUTHENTICATED_EVENT);
  });

  it('A9) 403 does NOT dispatch UNAUTHENTICATED_EVENT (forbidden is a permissions error, not an auth error)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 403,
      body: { error: { code: 'forbidden' } },
    })) as unknown as typeof fetch;
    await apiClient.post<unknown>('/projects', {});
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });

  it('A10) 404 does NOT dispatch UNAUTHENTICATED_EVENT (RLS-filtered rows look like not_found, must not boot to login)', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 404,
      body: { error: { code: 'not_found' } },
    })) as unknown as typeof fetch;
    await apiClient.get<unknown>('/projects/bad-id');
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });

  it('A11) 429 (rate limited) does NOT dispatch UNAUTHENTICATED_EVENT', async () => {
    globalThis.fetch = stubFetch(() => ({
      status: 429,
      body: { error: { code: 'too_many_requests' } },
    })) as unknown as typeof fetch;
    await apiClient.post<unknown>('/auth/login', {});
    expect(dispatchedEvents).not.toContain(UNAUTHENTICATED_EVENT);
  });

  // §v9-P0-4 SUPPRESS_EVENT coverage (D.31 G2 — form-level 401 codes
  // MUST NOT fire the global unauthenticated event; they belong to the
  // calling form's field-error UI). The api-client maintains the set
  // `SUPPRESS_EVENT = { invalid_credentials, invalid_otp, not_member,
  // invalid_step_up_code }` — each MUST be runtime-suppressed.
  // A12-suppress-N covers them generically (table-driven) so a future
  // addition to the SUPPRESS set is auto-tested. `invalid_step_up_code`
  // (7c F1): a wrong OTP typed in the PII unlock dialog is a form-level
  // concern — booting the session to /login on a typo would be hostile.
  const SUPPRESSED_CODES = [
    'invalid_credentials',
    'invalid_otp',
    'not_member',
    'invalid_step_up_code',
  ] as const;
  for (const code of SUPPRESSED_CODES) {
    it(`A12-suppress-${code}) 401 with code=${code} does NOT fire UNAUTHENTICATED_EVENT (form-level error)`, async () => {
      globalThis.fetch = stubFetch(() => ({
        status: 401,
        body: { error: { code } },
      })) as unknown as typeof fetch;
      // Wide call site — works for login, otp/verify, org/switch.
      await apiClient.post<unknown>('/auth/login', {});
      expect(
        dispatchedEvents,
        `${code} leaked the global unauthenticated event — would force-redirect the user away from the form mid-submit`,
      ).not.toContain(UNAUTHENTICATED_EVENT);
    });
  }

  it('A12-suppress-symmetry) every 401 code NOT in the suppress set DOES fire the event', async () => {
    // Adversarial complement: a brand-new 401 code (e.g. one introduced
    // by a future feature) MUST default to firing the event — the
    // suppress set is opt-in, not opt-out. Tests a representative
    // non-suppressed code; the SUPPRESS_EVENT set has to be amended
    // explicitly for new form-level codes.
    const newCode = 'session_revoked_by_admin'; // hypothetical future code
    globalThis.fetch = stubFetch(() => ({
      status: 401,
      body: { error: { code: newCode } },
    })) as unknown as typeof fetch;
    await apiClient.get<unknown>('/me');
    expect(dispatchedEvents.filter((e) => e === UNAUTHENTICATED_EVENT)).toHaveLength(1);
  });
});

describe('api-client request shape — adversarial', () => {
  it('A12) POST sends application/json + JSON-stringified body', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.post('/x', { a: 1 });
    const init = spy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{"a":1}');
  });

  it('A13) credentials: same-origin on every request (no cookies cross-site)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: null } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.get('/x');
    expect(spy.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });

  it('A14) URL is rooted at /api/v1 — same-origin (NO absolute URL leaks the backend hostname)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: null } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.get('/projects');
    expect(String(spy.mock.calls[0]?.[0])).toBe('/api/v1/projects');
  });

  it('A15) postIdempotent sends an Idempotency-Key header (CLOSED §v9-P0-3)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.postIdempotent('/projects', { name: 'X' });
    const init = spy.mock.calls[0]?.[1];
    const idem = (init?.headers as Record<string, string>)['Idempotency-Key'];
    // UUIDv4 shape: 36 chars with hyphens. Allow either 36-char UUID
    // OR a 32-char fallback (no-hyphen). Mostly UUID.
    expect(idem).toMatch(/^[0-9a-f-]{32,36}$/i);
  });

  it('A15b) plain post() does NOT add Idempotency-Key (call site opts in)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.post('/projects', { name: 'X' });
    const init = spy.mock.calls[0]?.[1];
    const idem = (init?.headers as Record<string, string>)['Idempotency-Key'];
    expect(idem).toBeUndefined();
  });

  it('A15c) two postIdempotent calls produce DIFFERENT keys (each user action = unique key)', async () => {
    const spy = stubFetch(() => ({ status: 200, body: { data: { ok: true } } }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiClient.postIdempotent('/projects', { name: 'A' });
    await apiClient.postIdempotent('/projects', { name: 'B' });
    const k1 = (spy.mock.calls[0]?.[1]?.headers as Record<string, string>)['Idempotency-Key'];
    const k2 = (spy.mock.calls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key'];
    expect(k1).not.toBe(k2);
  });
});

describe('api-client list envelope discrimination — adversarial', () => {
  it('A16) isList recognises { data: [...], page: {...} }', () => {
    expect(
      isList({
        data: [{ id: '1' }],
        page: { limit: 25, cursor: null, has_more: false },
      } as unknown as Parameters<typeof isList>[0]),
    ).toBe(true);
  });

  it('A17) isList rejects { data: {...} } (non-array data is a SINGLE resource, not a list)', () => {
    expect(
      isList({
        data: { id: '1' },
        page: { limit: 25, cursor: null, has_more: false },
      } as unknown as Parameters<typeof isList>[0]),
    ).toBe(false);
  });

  it('A18) isList rejects { error: ... }', () => {
    expect(isList({ error: { code: 'x' } } as unknown as Parameters<typeof isList>[0])).toBe(false);
  });
});
