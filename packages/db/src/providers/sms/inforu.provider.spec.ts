/**
 * Adversarial unit tests for the Inforu SMS provider (D.20 — Tenant OTP +
 * signature-link SMS). Pure unit: a fake `fetchImpl` is injected, so there is
 * NO network and NO DB. Authored by a separate test-author (separation of
 * concerns) — these tests do NOT trust the implementation and probe edge cases.
 */
import { describe, expect, it, vi } from 'vitest';

import { InforuSmsProvider, toInternational, type InforuSmsConfig } from './inforu.provider';

/** Build a fake fetch that resolves to a Response-like object. */
function fakeFetch(resolve: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
}): typeof fetch {
  const res = {
    ok: resolve.ok ?? true,
    status: resolve.status ?? 200,
    json: resolve.json ?? (async () => ({ StatusId: 1 })),
  } as unknown as Response;
  return vi.fn(async () => res) as unknown as typeof fetch;
}

function makeProvider(fetchImpl: typeof fetch, overrides: Partial<InforuSmsConfig> = {}) {
  const config: InforuSmsConfig = {
    apiUrl: 'https://capi.inforu.co.il',
    user: 'acct-user',
    token: 'secret-token',
    sender: 'EMAPP',
    fetchImpl,
    ...overrides,
  };
  return new InforuSmsProvider(config);
}

describe('InforuSmsProvider.send — status mapping', () => {
  it('StatusId===1 → status "sent"', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ StatusId: 1 }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('sent');
  });

  it('StatusId===2 + StatusDescription → status "rejected" with the description as error', async () => {
    const f = fakeFetch({
      ok: true,
      status: 200,
      json: async () => ({ StatusId: 2, StatusDescription: 'bad sender' }),
    });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('bad sender');
  });

  it('rejected status WITHOUT a description → falls back to status_<n>', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ StatusId: 7 }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('status_7');
  });

  it('StatusId as a numeric STRING "1" → still treated as sent (Number() coercion)', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ StatusId: '1' }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    // ADVERSARIAL: a real gateway may return numeric strings. Document behaviour.
    expect(result.status).toBe('sent');
  });

  it('missing StatusId entirely → rejected with status_unknown', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ foo: 'bar' }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('status_unknown');
  });

  // Regression (test-author finding): a non-number/non-string StatusId must NOT
  // be Number()-coerced into a false "sent" — `Number(true) === 1` previously
  // misclassified a malformed `{StatusId:true}` gateway body as a success.
  it('StatusId as boolean true → rejected (no junk-to-sent coercion)', async () => {
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ StatusId: true }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('status_unknown');
  });
});

describe('InforuSmsProvider.send — transport vs structural mapping (#509 exactly-once)', () => {
  // ── STRUCTURAL declines (gateway refused on a successful/4xx call) → `rejected`
  //    (DEFINITE non-send, safe to re-claim/retry). ──────────────────────────────
  it('HTTP 401 (auth — client error) → STRUCTURAL `rejected` with http_401', async () => {
    // A 4xx is the gateway refusing the request BEFORE dispatch → provably no send.
    const f = fakeFetch({ ok: false, status: 401, json: async () => ({ StatusId: 1 }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('http_401');
  });

  it('HTTP 400 (malformed — client error) → STRUCTURAL `rejected`', async () => {
    const f = fakeFetch({ ok: false, status: 400, json: async () => ({}) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('http_400');
  });

  // ── TRANSPORT-AMBIGUOUS (may have dispatched before failing) → `failed`
  //    (NEVER `rejected`; downstream parks it, never auto-resends). ──────────────
  it('HTTP 500 (server error) → AMBIGUOUS `failed` with http_500 (NOT rejected — may have sent)', async () => {
    const f = fakeFetch({ ok: false, status: 500, json: async () => ({ StatusId: 1 }) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('http_500');
  });

  it('HTTP 504 (gateway timeout) → AMBIGUOUS `failed` with http_504', async () => {
    const f = fakeFetch({ ok: false, status: 504, json: async () => ({}) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('http_504');
  });

  it('HTTP 408 (request timeout) → AMBIGUOUS `failed`', async () => {
    const f = fakeFetch({ ok: false, status: 408, json: async () => ({}) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('http_408');
  });

  it('HTTP 429 (rate limited) → AMBIGUOUS `failed`', async () => {
    const f = fakeFetch({ ok: false, status: 429, json: async () => ({}) });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('http_429');
  });

  it('fetchImpl rejects (network throw) → AMBIGUOUS `failed`, never throws, keeps the message', async () => {
    // The socket may have dropped AFTER the gateway dispatched → ambiguous.
    const f = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('fetchImpl rejects with a non-Error value → AMBIGUOUS `failed` with network_error', async () => {
    const f = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string-failure';
    }) as unknown as typeof fetch;
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('network_error');
  });

  it('res.json() rejects on a 2xx (unparseable body) → AMBIGUOUS `failed` with bad_json (2xx = may have dispatched)', async () => {
    const f = fakeFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    });
    const provider = makeProvider(f);
    const result = await provider.send('0501234567', 'hello');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('bad_json');
  });
});

describe('InforuSmsProvider.send — request shape', () => {
  async function capture(
    to: string,
    body: string,
    overrides: Partial<InforuSmsConfig> = {},
  ): Promise<{ url: string; init: RequestInit; parsedBody: any }> {
    let capturedUrl = '';
    let capturedInit: RequestInit = {};
    const f = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ StatusId: 1 }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = makeProvider(f, overrides);
    await provider.send(to, body);
    return {
      url: capturedUrl,
      init: capturedInit,
      parsedBody: JSON.parse(String(capturedInit.body)),
    };
  }

  it('POSTs to {apiUrl}/api/v2/SMS/SendSms', async () => {
    const { url, init } = await capture('0501234567', 'hi');
    expect(url).toBe('https://capi.inforu.co.il/api/v2/SMS/SendSms');
    expect(init.method).toBe('POST');
  });

  it('a trailing slash on apiUrl does NOT produce a double slash', async () => {
    const { url } = await capture('0501234567', 'hi', { apiUrl: 'https://capi.inforu.co.il/' });
    expect(url).toBe('https://capi.inforu.co.il/api/v2/SMS/SendSms');
  });

  it('multiple trailing slashes on apiUrl are collapsed', async () => {
    const { url } = await capture('0501234567', 'hi', { apiUrl: 'https://capi.inforu.co.il///' });
    expect(url).toBe('https://capi.inforu.co.il/api/v2/SMS/SendSms');
  });

  it('Authorization header is Basic base64(user:token)', async () => {
    const { init } = await capture('0501234567', 'hi');
    const headers = init.headers as Record<string, string>;
    const expected = 'Basic ' + Buffer.from('acct-user:secret-token').toString('base64');
    expect(headers.Authorization).toBe(expected);
  });

  it('Content-Type is application/json', async () => {
    const { init } = await capture('0501234567', 'hi');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('body carries Data.Message, Data.Recipients[0].Phone (international), Data.Settings.Sender', async () => {
    const { parsedBody } = await capture('0501234567', 'my-message-body');
    expect(parsedBody.Data.Message).toBe('my-message-body');
    expect(parsedBody.Data.Recipients[0].Phone).toBe('972501234567');
    expect(parsedBody.Data.Recipients[0].Phone).toBe(toInternational('0501234567'));
    expect(parsedBody.Data.Settings.Sender).toBe('EMAPP');
  });
});

describe('toInternational', () => {
  it("'0501234567' → '972501234567'", () => {
    expect(toInternational('0501234567')).toBe('972501234567');
  });

  it("'972501234567' → passthrough", () => {
    expect(toInternational('972501234567')).toBe('972501234567');
  });

  it("'+972-50-123-4567' → '972501234567' (strips non-digits)", () => {
    expect(toInternational('+972-50-123-4567')).toBe('972501234567');
  });

  it("formatted local '050-123-4567' → '972501234567'", () => {
    expect(toInternational('050-123-4567')).toBe('972501234567');
  });

  it("'+972501234567' (already international, with +) → '972501234567'", () => {
    expect(toInternational('+972501234567')).toBe('972501234567');
  });

  it('empty string → empty string (no crash)', () => {
    expect(toInternational('')).toBe('');
  });
});

describe('InforuSmsProvider — PRIVACY (adversarial)', () => {
  it('does NOT write the full phone or the message body to stdout/stderr on success', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fakeFetch({ ok: true, status: 200, json: async () => ({ StatusId: 1 }) });
    const provider = makeProvider(f);
    await provider.send('0501234567', 'SECRET-OTP-998877');
    const allWrites = [...outSpy.mock.calls, ...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((x) => String(x))
      .join('\n');
    expect(allWrites).not.toContain('0501234567');
    expect(allWrites).not.toContain('972501234567');
    expect(allWrites).not.toContain('SECRET-OTP-998877');
    outSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('does NOT leak the phone or body on a rejected response either', async () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fakeFetch({
      ok: true,
      status: 200,
      json: async () => ({ StatusId: 2, StatusDescription: 'bad sender' }),
    });
    const provider = makeProvider(f);
    await provider.send('0507654321', 'SECRET-OTP-112233');
    const allWrites = [...outSpy.mock.calls, ...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((x) => String(x))
      .join('\n');
    expect(allWrites).not.toContain('0507654321');
    expect(allWrites).not.toContain('972507654321');
    expect(allWrites).not.toContain('SECRET-OTP-112233');
    outSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
