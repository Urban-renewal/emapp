/**
 * §E2E Mock Backend — minimal Node-side HTTP server.
 *
 * Why this exists:
 * Playwright's `page.route()` only intercepts BROWSER fetches. The
 * dashboard layout (`apps/web/src/app/[locale]/(dashboard)/layout.tsx`)
 * is a Server Component that calls `getMe()` → server-side fetch to
 * `${selfOrigin}/api/v1/me` → `apps/web/src/app/api/[...path]/route.ts`
 * proxy → `${API_BACKEND_URL}/api/v1/me`. That whole chain runs INSIDE
 * the Next.js Node process; `page.route()` cannot see any of it.
 *
 * Without this seam:
 *  - any post-auth journey (J2–J15) would either redirect-loop in SSR
 *    (cookie present → layout calls /me → real BE not reachable →
 *    getMe returns null → redirect /login → middleware sees cookie →
 *    /he/ → layout fails again → ∞), or hang the dev server entirely.
 *  - we'd be stuck shipping ONLY signup/login form contracts.
 *
 * With this seam:
 *  - playwright.config sets `API_BACKEND_URL=http://127.0.0.1:<MOCK_PORT>`
 *    in the webServer env. The Next proxy forwards every server-side
 *    /api/v1/* call here.
 *  - Each test can register per-request handlers via `setMockHandler()`
 *    BEFORE Playwright navigates. Defaults to a Manager user from the
 *    seed-dev fixture identity.
 *  - Idempotent reset between tests via `resetMockHandlers()`.
 *
 * Strict scope:
 *  - This server handles the SERVER-SIDE PROXY traffic only. Browser-
 *    side fetches are still stubbed via `page.route()` per-test (each
 *    test has full per-request control + can capture wire shape there).
 *  - Returning D.16 envelopes (`{ data }` / `{ error: { code } }`)
 *    is the contract; tests should not need to manually wrap.
 *
 * Security posture:
 *  - Listens on 127.0.0.1 ONLY — never accessible off-host.
 *  - Refuses to start if NODE_ENV === 'production' (defense in depth).
 *  - Cookie inspection is permissive — anything that looks like a
 *    valid bearer-shape cookie is honored. This is a MOCK, not a
 *    security gate; the security model is "tests construct the
 *    scenarios they want to exercise".
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/** D.16 success / error envelopes. */
export type MockResponse =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { status: number; raw: string; contentType?: string; headers?: Record<string, string> };

/** Key = `${METHOD} ${path}` (path WITHOUT query). */
type HandlerKey = `${string} ${string}`;
type MockHandler = (req: IncomingMessage, body: string) => MockResponse | Promise<MockResponse>;

const handlers = new Map<HandlerKey, MockHandler>();
const requestLog: Array<{ method: string; url: string; body: string; cookie: string | null }> = [];

const DEFAULT_PORT = 9999;

/** Seed-dev manager identity (mirrors packages/db/scripts/seed-dev.ts). */
export const SEED_MANAGER = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'מיכל מנהלת',
  email: 'manager@alpha.dev',
  role: 'manager',
  avatarColor: '#0f766e',
  organization: {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Alpha',
    slug: 'alpha-dev',
  },
} as const;

export const SEED_AGENT = {
  ...SEED_MANAGER,
  id: '00000000-0000-4000-8000-000000000003',
  name: 'אבי סוכן',
  email: 'agent@alpha.dev',
  role: 'agent',
  avatarColor: '#1d4ed8',
} as const;

export const SEED_VIEWER = {
  ...SEED_MANAGER,
  id: '00000000-0000-4000-8000-000000000004',
  name: 'ויקי צופה',
  email: 'viewer@alpha.dev',
  role: 'viewer',
  avatarColor: '#a16207',
} as const;

/** Per-test override registration. Caller MUST `resetMockHandlers()` in
 *  afterEach so handlers don't leak across tests. */
export function setMockHandler(method: string, path: string, handler: MockHandler): void {
  handlers.set(`${method.toUpperCase()} ${path}`, handler);
}

export function resetMockHandlers(): void {
  handlers.clear();
  requestLog.length = 0;
}

/** Inspect what the proxy actually called during a test — used for
 *  server-side request-shape assertions where browser-side `page.route`
 *  cannot reach.
 *
 *  §process-boundary — Playwright spawns test workers in subprocesses.
 *  Each worker has its OWN copy of this module (the HTTP server is an
 *  OS-level resource started by globalSetup in the parent process; the
 *  in-memory `requestLog` here is per-process). Workers MUST use
 *  `fetchRequestLog()` (HTTP-backed) instead of this function. Kept
 *  for in-process callers (unit tests of the mock itself). */
export function getRequestLog(): ReadonlyArray<{
  method: string;
  url: string;
  body: string;
  cookie: string | null;
}> {
  return requestLog;
}

/** Fetch the parent-process request log over HTTP — works across the
 *  globalSetup ↔ test-worker process boundary. Test specs should use
 *  this for the §AXIS-A server-side-call assertion. */
export async function fetchRequestLog(
  port: number = DEFAULT_PORT,
): Promise<ReadonlyArray<{ method: string; url: string; body: string; cookie: string | null }>> {
  const res = await fetch(`http://127.0.0.1:${port}/__test_log`);
  if (!res.ok) {
    throw new Error(`[mock-backend] /__test_log returned ${res.status}`);
  }
  return (await res.json()) as ReadonlyArray<{
    method: string;
    url: string;
    body: string;
    cookie: string | null;
  }>;
}

/** Reset the parent-process log over HTTP. The fixture's per-test
 *  reset must use THIS, not `resetMockHandlers` (which only clears
 *  the worker-local module state). */
export async function fetchResetRequestLog(port: number = DEFAULT_PORT): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/__test_log`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`[mock-backend] DELETE /__test_log returned ${res.status}`);
  }
}

/** Default handlers — extend as more journeys land. */
function installDefaultHandlers(): void {
  // §J1+ — `/me` returns Manager identity when an access_token cookie
  // is present (any value — the mock trusts the test). Returns 401
  // when no cookie, so logout / session-expired flows can be exercised.
  setMockHandler('GET', '/api/v1/me', (req) => {
    const cookieHeader = req.headers.cookie ?? '';
    const hasAccessToken = /(?:^|;\s*)access_token=([^;]+)/.exec(cookieHeader);
    if (!hasAccessToken) {
      return {
        status: 401,
        body: { error: { code: 'missing_token', message: 'no access_token cookie' } },
      };
    }
    // Differentiate user by cookie value prefix so tests can simulate
    // role without a full token-mint round-trip.
    const token = hasAccessToken[1] ?? '';
    let user: typeof SEED_MANAGER = SEED_MANAGER;
    if (token.startsWith('e2e-agent')) user = SEED_AGENT as unknown as typeof SEED_MANAGER;
    else if (token.startsWith('e2e-viewer')) user = SEED_VIEWER as unknown as typeof SEED_MANAGER;
    return { status: 200, body: { data: user } };
  });

  // §J15 — logout always succeeds (cookies cleared client-side by
  // proxy; the mock just acknowledges).
  setMockHandler('POST', '/api/v1/auth/logout', () => ({
    status: 200,
    body: { data: { ok: true } },
  }));

  // §Phase-4c — notifications bell polls /api/v1/notifications on
  // every dashboard render (apps/web/src/hooks/use-notifications.ts).
  // Without this handler, /he/ navigation 404s on every E2E test and
  // the §P0-3 guardrail fires. Return an empty list so the bell
  // renders with zero unread — the relevant FE state is the same
  // whether the list is empty or has items.
  setMockHandler('GET', '/api/v1/notifications', () => ({
    status: 200,
    body: {
      data: [],
      page: { limit: 5, cursor: null, has_more: false },
    },
  }));

  // §J14 — refresh: succeeds by default (covers silent-refresh test
  // by per-test override that returns 401 first then OK).
  setMockHandler('POST', '/api/v1/auth/refresh', () => ({
    status: 200,
    body: { data: { ok: true } },
    headers: {
      'Set-Cookie': [
        'access_token=e2e-refreshed-access; Path=/; HttpOnly; SameSite=Lax',
        'refresh_token=e2e-refreshed-refresh; Path=/api/v1/auth/refresh; HttpOnly; SameSite=Lax',
      ].join(', '),
    },
  }));
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = (req.method ?? 'GET').toUpperCase();
  const path = pathOf(url);

  // §test-introspection — `/__test_log` is the cross-process channel
  // for `fetchRequestLog()` / `fetchResetRequestLog()`. Served BEFORE
  // the normal handler lookup so it doesn't show up in the log itself
  // (would confuse the asserting test).
  if (path === '/__test_log') {
    if (method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requestLog));
      return;
    }
    if (method === 'DELETE') {
      requestLog.length = 0;
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
    return;
  }

  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : '';

  requestLog.push({
    method,
    url,
    body,
    cookie: req.headers.cookie ?? null,
  });

  const handler = handlers.get(`${method} ${path}`);
  if (!handler) {
    // No handler registered → 404 in D.16 envelope so the FE error
    // path runs through `error.code === 'not_found'` (the no-oracle
    // contract per ARCHITECTURE-MAP.md §3).
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'not_found', message: `mock-backend: no handler for ${method} ${path}` },
      }),
    );
    return;
  }

  const out = await handler(req, body);
  res.statusCode = out.status;
  if (out.headers) {
    for (const [k, v] of Object.entries(out.headers)) {
      res.setHeader(k, v);
    }
  }
  if ('raw' in out) {
    res.setHeader('Content-Type', out.contentType ?? 'text/plain');
    res.end(out.raw);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out.body));
  }
}

let server: Server | null = null;
let listeningPort: number | null = null;

export interface StartOptions {
  port?: number;
}

export async function startMockBackend(opts: StartOptions = {}): Promise<number> {
  if (server) {
    throw new Error('[mock-backend] already running');
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('[mock-backend] refusing to start in production');
  }
  installDefaultHandlers();
  const port = opts.port ?? DEFAULT_PORT;
  const s = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- operator-facing during tests
      console.error('[mock-backend] handler threw', err);
      try {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'mock_handler_failure' } }));
      } catch {
        /* socket already gone */
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve());
  });
  server = s;
  listeningPort = port;
  return port;
}

export async function stopMockBackend(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => (err ? reject(err) : resolve()));
  });
  server = null;
  listeningPort = null;
  handlers.clear();
  requestLog.length = 0;
}

export function getMockBackendPort(): number {
  if (listeningPort === null) throw new Error('[mock-backend] not running');
  return listeningPort;
}
