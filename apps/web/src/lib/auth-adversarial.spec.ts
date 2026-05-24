/**
 * AUDIT — adversarial spec for the auth Server Actions.
 *
 * §v9-H-1 closure pin — selfOrigin allowlist refuses Host headers
 * not in `SELF_ORIGIN_ALLOWLIST`. A future regression that drops
 * the allowlist would reopen the token-exfiltration vector.
 *
 * §v9-M-11 closure pin — getMe makes the upstream call only when
 * the Host is allowlisted AND the access_token cookie is present.
 *
 * The spec stubs `next/headers` (cookies + headers helpers) and
 * `globalThis.fetch` so it runs in pure Node with no HTTP server.
 */
import { UserProfileSchema } from '@emapp/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next/headers BEFORE importing the SUT.
type CookieRecord = Map<string, { value: string }>;
let mockCookies: CookieRecord = new Map();
let mockHeaders: Map<string, string> = new Map();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => mockCookies.get(name),
    delete: (name: string) => {
      mockCookies.delete(name);
    },
  }),
  headers: async () => ({
    get: (name: string) => mockHeaders.get(name.toLowerCase()) ?? null,
  }),
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockCookies = new Map();
  mockHeaders = new Map();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SAMPLE_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Test User',
  email: 'u@a.dev',
  role: 'manager',
  avatarColor: null,
  organization: { id: '22222222-2222-2222-2222-222222222222', name: 'A', slug: 'a-dev' },
};

describe('selfOrigin allowlist (§v9-H-1)', () => {
  it('H1-1) malicious Host (evil.com) → getMe returns null and NO fetch is made', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'evil.com');
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { getMe } = await import('./auth');
    const result = await getMe();
    expect(result).toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('H1-2) allowlisted Host (app.emapp.io) → fetch IS made to the correct origin', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'app.emapp.io');
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: SAMPLE_USER }),
      } as unknown as Response),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { getMe } = await import('./auth');
    await getMe();
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(url).toBe('https://app.emapp.io/api/v1/me');
  });

  it('H1-3) localhost dev origin (localhost:3001) → http:// fetch', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'localhost:3001');
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: SAMPLE_USER }),
      } as unknown as Response),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { getMe } = await import('./auth');
    await getMe();
    expect(String(fetchSpy.mock.calls[0]?.[0] ?? '')).toBe('http://localhost:3001/api/v1/me');
  });

  it('H1-4) Host with embedded credentials / path is treated as not in the allowlist → null', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'app.emapp.io@evil.com');
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { getMe } = await import('./auth');
    expect(await getMe()).toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('H1-5) no access_token cookie → null without any fetch', async () => {
    mockHeaders.set('host', 'app.emapp.io');
    const fetchSpy = vi.fn(() => Promise.reject(new Error('must not be called')));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { getMe } = await import('./auth');
    expect(await getMe()).toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('getMe e2e (§v9-M-11 closure — getMe → proxy → /me round trip)', () => {
  it('M11-1) successful /me response → parsed UserProfile returned', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'app.emapp.io');
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: SAMPLE_USER }),
      } as unknown as Response),
    ) as unknown as typeof fetch;

    const { getMe } = await import('./auth');
    const me = await getMe();
    expect(me).not.toBe(null);
    expect(UserProfileSchema.safeParse(me).success).toBe(true);
  });

  it('M11-2) 401 from upstream → null (no throw, no PII leak in any error)', async () => {
    mockCookies.set('access_token', { value: 'EXPIRED' });
    mockHeaders.set('host', 'app.emapp.io');
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'invalid_token' } }),
      } as unknown as Response),
    ) as unknown as typeof fetch;
    const { getMe } = await import('./auth');
    expect(await getMe()).toBe(null);
  });

  it('M11-3) malformed upstream JSON → null (caught in try/catch — no propagation)', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'app.emapp.io');
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error('parse failed')),
      } as unknown as Response),
    ) as unknown as typeof fetch;
    const { getMe } = await import('./auth');
    expect(await getMe()).toBe(null);
  });

  it('M11-4) wire shape that fails UserProfileSchema → null (defensive parse)', async () => {
    mockCookies.set('access_token', { value: 'TOKEN' });
    mockHeaders.set('host', 'app.emapp.io');
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { foo: 'bar' } }),
      } as unknown as Response),
    ) as unknown as typeof fetch;
    const { getMe } = await import('./auth');
    expect(await getMe()).toBe(null);
  });

  it('M11-5) Cookie header is forwarded on the upstream fetch', async () => {
    mockCookies.set('access_token', { value: 'TOK-VALUE' });
    mockHeaders.set('host', 'app.emapp.io');
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: SAMPLE_USER }),
      } as unknown as Response),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { getMe } = await import('./auth');
    await getMe();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Cookie']).toBe('access_token=TOK-VALUE');
  });
});
