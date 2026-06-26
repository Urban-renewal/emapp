/**
 * Phase 4a S1 guard tests.
 *
 * 1. `API_URL` may NEVER reappear in apps/web source. D.35 mandates a
 *    single env var (`API_BACKEND_URL`) for the backend hostname; any
 *    `process.env['API_URL']` / `process.env.API_URL` is a regression
 *    that re-introduces the old dual-config bug (the FE had a server-
 *    side path bypassing the Pages Function with its own env knob).
 *
 * 2. `NEXT_PUBLIC_API_URL` may NEVER appear in apps/web source. D.35
 *    explicitly forbids exposing the backend URL to the browser
 *    bundle — would break the cookie hostOnly model.
 *
 * The scan is a plain regex over the source tree, NOT a Node `require`
 * walk (would drag transpile deps). Spec files themselves are excluded
 * so the literal regex doesn't false-match.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks for the getMe behavioural tests (server-direct hop) -------------
// `next/headers` is a server-only module; stub cookies() + headers() so the
// Server Action runs in vitest. Each test seeds the return values.
const cookieGet = vi.fn();
const headerGet = vi.fn();

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet, delete: vi.fn() })),
  headers: vi.fn(async () => ({ get: headerGet })),
}));

// React `cache()` is a pass-through in unit context (no request scope); make
// it the identity so getMeCached is a plain memo-free async fn per test.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const SRC_ROOT = join(__dirname, '..');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      yield* walk(full);
    } else if (st.isFile()) {
      const ext = extname(full);
      if (ext === '.ts' || ext === '.tsx') yield full;
    }
  }
}

function findOccurrences(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    // Exclude all spec files — they're allowed to reference forbidden
    // names as test data (this very file does).
    if (file.endsWith('.spec.ts')) continue;
    const text = readFileSync(file, 'utf8');
    if (pattern.test(text)) hits.push(file);
  }
  return hits;
}

describe('Phase 4a S1 — env-var contract guard', () => {
  it('1) process.env API_URL is never used in apps/web', () => {
    const hits = findOccurrences(/process\.env\s*(?:\[\s*['"]API_URL['"]\s*\]|\.API_URL\b)/);
    expect(hits).toEqual([]);
  });

  it('2) NEXT_PUBLIC_API_URL never appears in apps/web source', () => {
    const hits = findOccurrences(/NEXT_PUBLIC_API_URL/);
    expect(hits).toEqual([]);
  });
});

/**
 * getMe() server-direct-hop behaviour (§v9-M-9 reversed — latency).
 * Proves the server fetch goes STRAIGHT to `${API_BACKEND_URL}/api/v1/me`
 * (no Pages-Function self-hop), still forwards the access_token cookie, and
 * preserves 401→null + return-shape. Falls back to the self-origin proxy
 * only when `API_BACKEND_URL` is unset.
 */
describe('getMe — server-direct hop to API_BACKEND_URL', () => {
  const VALID_PROFILE = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'מנהל בדיקה',
    email: 'manager@alpha.dev',
    role: 'manager',
    avatarColor: null,
    organization: {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Alpha',
      slug: 'alpha',
    },
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    cookieGet.mockReset();
    headerGet.mockReset();
    delete process.env['API_BACKEND_URL'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['API_BACKEND_URL'];
  });

  function okResponse() {
    return { ok: true, json: async () => ({ data: VALID_PROFILE }) } as Response;
  }

  // 20s per test: the first dynamic `import('./auth')` in a cold CI runner
  // compiles the module + the mocked `react`/`next/headers` graph, which can
  // exceed the 5s default; the fetch itself is fully mocked (no real I/O).
  it(
    'hits the API backend directly (NOT the self-origin proxy) and forwards the cookie',
    { timeout: 20_000 },
    async () => {
      process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
      cookieGet.mockReturnValue({ value: 'tok-abc' });
      // If the code ever consulted the Host, this would prove it didn't need to.
      headerGet.mockReturnValue('app.emapp.io');
      fetchMock.mockResolvedValue(okResponse());

      const { getMe } = await import('./auth');
      const profile = await getMe();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      // Direct to the backend base — the self-hop ${origin}/api/v1/me is gone.
      expect(url).toBe('https://api.internal.railway/api/v1/me');
      expect((init.headers as Record<string, string>).Cookie).toBe('access_token=tok-abc');
      expect(init.cache).toBe('no-store');
      expect(profile?.email).toBe('manager@alpha.dev');
    },
  );

  it('trims a trailing slash on API_BACKEND_URL (no double slash)', async () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway/';
    cookieGet.mockReturnValue({ value: 'tok-abc' });
    fetchMock.mockResolvedValue(okResponse());

    const { getMe } = await import('./auth');
    await getMe();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.internal.railway/api/v1/me');
  });

  it('returns null without fetching when no access_token cookie', async () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
    cookieGet.mockReturnValue(undefined);

    const { getMe } = await import('./auth');
    expect(await getMe()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 401 (or any non-ok) to null', async () => {
    process.env['API_BACKEND_URL'] = 'https://api.internal.railway';
    cookieGet.mockReturnValue({ value: 'tok-abc' });
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);

    const { getMe } = await import('./auth');
    expect(await getMe()).toBeNull();
  });

  it('falls back to the §v9-H-1 self-origin proxy when API_BACKEND_URL is unset', async () => {
    // No API_BACKEND_URL → proxy path. Host must be allowlisted.
    cookieGet.mockReturnValue({ value: 'tok-abc' });
    headerGet.mockImplementation((name: string) => (name === 'host' ? 'localhost:3001' : null));
    fetchMock.mockResolvedValue(okResponse());

    const { getMe } = await import('./auth');
    await getMe();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:3001/api/v1/me');
  });
});
