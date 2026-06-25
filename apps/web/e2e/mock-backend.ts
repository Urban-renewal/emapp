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

// IAM slice 5b — `/me` now ships the actor's effective PERMISSIONS (the FE gates
// controls/nav on them client-side via `useHasPermission`, NOT the legacy role
// string). The mock must mirror that or every permission-gated control vanishes
// in e2e. These sets mirror the resolved engine sets (system-roles.ts + the
// `export.run ⇒ <r>.read` closure), narrowed to the strings the FE actually
// gates on. `view_owner_pii` mirrors the BE reveal authority (manager always).

/**
 * Manager effective gate-permissions = the FULL operational set (system-roles.ts
 * `MANAGER = ALL_OPERATIONAL + members.*`; ALL_OPERATIONAL = the catalog minus
 * members./roles./org. governance) PLUS `members.read` (reached via the
 * `export.run ⇒ members.read` closure so the roster nav renders).
 *
 * This MUST be the full operational set, not a hand-picked subset: once `/me`
 * is SEEDED into the client cache from the server session (PR #401), EVERY
 * `useHasPermission` gate reads THIS — so any operational permission a real
 * manager holds but the mock omits makes that control vanish in e2e (e.g. the
 * tabu-review section gating on `apartments.read`, the sensitive-document
 * download on `documents.download`). Mirrors the engine's manager set exactly.
 */
const MANAGER_PERMISSIONS = [
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.archive',
  'buildings.read',
  'buildings.create',
  'buildings.update',
  'buildings.archive',
  'apartments.read',
  'apartments.create',
  'apartments.update',
  'apartments.archive',
  'owners.read',
  'owners.create',
  'owners.update',
  'owners.archive',
  'owners.reveal_pii',
  'ownerships.read',
  'ownerships.set',
  'documents.read',
  'documents.create',
  'documents.update',
  'documents.archive',
  'documents.download',
  'signature_requests.read',
  'signature_requests.send',
  'signature_requests.cancel',
  'tasks.read',
  'tasks.create',
  'tasks.update',
  'tasks.archive',
  'notes.read',
  'notes.create',
  'notes.update',
  'notes.archive',
  'contractors.read',
  'contractors.create',
  'contractors.update',
  'contractors.archive',
  'shares.create',
  'shares.revoke',
  'project_assignments.read',
  'project_assignments.manage',
  'imports.read',
  'imports.run',
  'imports.cancel',
  'imports.map',
  'mapping_templates.read',
  'mapping_templates.manage',
  'export.run',
  'stats.read',
  'audit.read',
  'members.read',
] as const;

/** Agent: operational writes on assigned scope; NO governance reads, no
 *  project/owner creation, no reveal/export/staffing. */
const AGENT_PERMISSIONS = [
  'projects.archive',
  'buildings.create',
  'apartments.create',
  // owners.read — the default seed-dev agent has the `view_owners` capability
  // ON (j18 default set), so their EFFECTIVE permissions include owners.read
  // (BE `agent-effective-permissions` keeps it iff view_owners). The Owners nav
  // item (P4 #11) gates on this; mirror it so the link renders for the agent.
  'owners.read',
  'owners.archive',
  'documents.create',
  'contractors.create',
  'contractors.archive',
  'notes.create',
  'notes.update',
  'notes.archive',
  'tasks.create',
  'tasks.update',
  'signature_requests.send',
  'imports.run',
] as const;

/** Seed-dev manager identity (mirrors packages/db/scripts/seed-dev.ts). */
export const SEED_MANAGER = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'מיכל מנהלת',
  email: 'manager@alpha.dev',
  role: 'manager',
  avatarColor: '#0f766e',
  permissions: [...MANAGER_PERMISSIONS],
  view_owner_pii: true,
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
  permissions: [...AGENT_PERMISSIONS],
  view_owner_pii: false,
} as const;

export const SEED_VIEWER = {
  ...SEED_MANAGER,
  id: '00000000-0000-4000-8000-000000000004',
  name: 'ויקי צופה',
  email: 'viewer@alpha.dev',
  role: 'viewer',
  avatarColor: '#a16207',
  // Read-only of operational data — holds NONE of the gated write/governance
  // controls (no members.read/audit.read → Members+Audit nav hidden). Holds
  // owners.read (VIEWER role = all operational reads, PII masked) → the Owners
  // nav item (P4 #11) renders for the viewer (j9 positive control).
  permissions: ['owners.read'],
  view_owner_pii: false,
} as const;

/** Provider Admin (Tier 3) — D.37. Mirrors the shape `/api/v1/provider/me`
 *  returns post-V10-S1 (apps/api/src/modules/auth/provider/provider-me.controller.ts).
 *  Deliberately narrower than SEED_MANAGER: no `organization` (Provider is
 *  cross-tenant), no avatarColor (operational tier, not branded). */
export const SEED_PROVIDER = {
  id: '00000000-0000-4000-8000-000000000099',
  name: 'Lidor Provider Admin',
  email: 'admin@emapp.io',
  role: 'provider_admin',
} as const;

/** Sample tenants the mock provider sees. PII-free at the list level
 *  (D.37 — name + slug + counts only; no owner-row data). */
export const SEED_PROVIDER_TENANTS = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'Alpha Urban Renewal',
    slug: 'alpha-dev',
    createdAt: '2026-01-15T10:00:00.000Z',
    archivedAt: null,
    suspendedAt: null,
    counts: { users: 5, projects: 3, owners: 42 },
  },
  {
    id: '00000000-0000-4000-8000-0000000000a2',
    name: 'Beta Tama 38',
    slug: 'beta-tama',
    createdAt: '2026-02-20T10:00:00.000Z',
    archivedAt: null,
    suspendedAt: null,
    counts: { users: 2, projects: 1, owners: 18 },
  },
] as const;

/** Cross-process suspension state for the D.49 provider-write mock.
 *  The mock server is a separate subprocess, so this lives here (in the
 *  server module) and is cleared by the `DELETE /__test_log` reset that
 *  tests already fire in `beforeEach` via `fetchResetRequestLog()`. */
const suspendedTenants = new Set<string>();

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

  // The bell ALSO calls the constant-time unread-count endpoint on every
  // dashboard render (apps/web/src/hooks/use-notifications.ts useUnreadCount).
  // Same reason as the list above: without this default handler /he/ navigation
  // 404s on every E2E test and the §P0-3 console guardrail fires. Zero unread.
  setMockHandler('GET', '/api/v1/notifications/unread-count', () => ({
    status: 200,
    body: { data: { count: 0 } },
  }));

  // Team messaging (Slice 3) — the messages surface (/messages page) and the
  // sidebar conversations badge poll /api/v1/conversations and side-load
  // /api/v1/members. Like the notifications bell above, without these handlers
  // /he/ navigation 404s on every E2E test and the §P0-3 console guardrail fires.
  // Empty lists — the FE state (empty list) is the same whether the lists are
  // empty or populated. Per-test page.route() stubs still override these for the
  // messaging-specific specs.
  setMockHandler('GET', '/api/v1/conversations', () => ({
    status: 200,
    body: {
      data: [],
      page: { limit: 25, cursor: null, has_more: false },
    },
  }));
  // Org-wide conversations unread total (constant-time aggregate). A future nav
  // badge polls this; default to zero so any SERVER-side path never 404s and the
  // §P0-3 console guardrail stays green. Per-test page.route() can override.
  setMockHandler('GET', '/api/v1/conversations/unread-count', () => ({
    status: 200,
    body: { data: { count: 0 } },
  }));
  setMockHandler('GET', '/api/v1/members', () => ({
    status: 200,
    body: {
      data: [],
      page: { limit: 100, cursor: null, has_more: false },
    },
  }));

  // Approval-Inbox pending-decisions count. The sidebar's manager-only inbox row
  // now polls this constant-time aggregate (apps/web/src/hooks/use-proposals.ts
  // useProposalsPendingCount) on EVERY dashboard render, so — like the
  // notifications/conversations unread-count handlers above — without this default
  // /he/ navigation would 404 on every E2E test as the manager and the §P0-3
  // console guardrail would fire. Zero pending. Per-test page.route() can override.
  setMockHandler('GET', '/api/v1/proposals/pending-count', () => ({
    status: 200,
    body: { data: { count: 0 } },
  }));

  // E2 Wave-2 B1 — the board-first home (the post-login landing) reads
  // /api/v1/org/signature-pulse. The home is a CLIENT island so browser-side
  // page.route() normally answers it; this default handler covers any SERVER-
  // side path (or a test that lands on /he/ without its own stub) so the proxy
  // never 404s the home. Empty all-clear pulse → the calm reward state.
  setMockHandler('GET', '/api/v1/org/signature-pulse', () => ({
    status: 200,
    body: {
      data: {
        buckets: { stalled: 0, expiringSoon: 0, needsHuman: 0, onTrack: 0 },
        attention: [],
        // HB-1 — the campaign-send kill-switch state (required by the schema as
        // of #470). Default-on so the board renders the live remind action.
        sendEnabled: true,
      },
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

  // ─── V10-S1/S2/S3 — Provider tier (J11 happy-path) ───
  //
  // Anti-enum: every 401 path on /provider/auth/login returns the SAME
  // `invalid_credentials` shape — matches the BE contract
  // (provider-auth.service.ts:91). A real attacker can't distinguish
  // wrong-password from wrong-MFA from disabled-user.
  //
  // Cookies: mirror the BE shape exactly (provider-auth.controller.ts:21):
  //  - `provider_access_token` at Path=/ (30 min)
  //  - `provider_refresh_token` at Path=/api/v1/provider/auth/refresh (4 h)
  // Wrong path on either cookie breaks the FE logout flow silently;
  // mock parity matters for that test.
  setMockHandler('POST', '/api/v1/provider/auth/login', (_req, body) => {
    // The mock trusts ANY non-empty (email + password + mfa_code) tuple.
    // We re-check the shape defensively so a malformed test payload
    // surfaces as 401 (anti-enum — same code as wrong credentials).
    let parsed: { email?: string; password?: string; mfa_code?: string } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return { status: 401, body: { error: { code: 'invalid_credentials' } } };
    }
    if (!parsed.email || !parsed.password || !parsed.mfa_code) {
      return { status: 401, body: { error: { code: 'invalid_credentials' } } };
    }
    return {
      status: 200,
      body: { data: { ok: true } },
      headers: {
        'Set-Cookie': [
          'provider_access_token=e2e-provider-access; Path=/; HttpOnly; SameSite=Lax',
          'provider_refresh_token=e2e-provider-refresh; Path=/api/v1/provider/auth/refresh; HttpOnly; SameSite=Lax',
        ].join(', '),
      },
    };
  });

  // /provider/me — returns SEED_PROVIDER iff the provider cookie is
  // present. Anti-enum 401 otherwise (same code as expired/wrong-audience
  // on the BE — see provider-me.controller.ts).
  setMockHandler('GET', '/api/v1/provider/me', (req) => {
    const cookieHeader = req.headers.cookie ?? '';
    const hasProviderToken = /(?:^|;\s*)provider_access_token=([^;]+)/.test(cookieHeader);
    if (!hasProviderToken) {
      return {
        status: 401,
        body: { error: { code: 'invalid_token', message: 'no provider_access_token' } },
      };
    }
    return { status: 200, body: { data: SEED_PROVIDER } };
  });

  // /provider/auth/logout — clears cookies + acknowledges.
  setMockHandler('POST', '/api/v1/provider/auth/logout', () => ({
    status: 200,
    body: { data: { ok: true } },
  }));

  // /provider/tenants — list (D.37). Returns SEED_PROVIDER_TENANTS when
  // the provider cookie is present + the `access_reason` HTTP header
  // (snake_case, mirrors the BE access-reason.decorator.ts contract +
  // the audit_log column) is populated. BE 400 reason_required
  // otherwise. The mock matches BOTH guards.
  setMockHandler('GET', '/api/v1/provider/tenants', (req) => {
    const cookieHeader = req.headers.cookie ?? '';
    const hasProviderToken = /(?:^|;\s*)provider_access_token=([^;]+)/.test(cookieHeader);
    if (!hasProviderToken) {
      return { status: 401, body: { error: { code: 'invalid_token' } } };
    }
    const reason = req.headers['access_reason'];
    if (!reason || (typeof reason === 'string' && reason.trim().length === 0)) {
      return { status: 400, body: { error: { code: 'reason_required' } } };
    }
    return {
      status: 200,
      body: {
        data: SEED_PROVIDER_TENANTS,
        page: { limit: 25, cursor: null, has_more: false },
      },
    };
  });

  // POST /provider/tenants — D.45 onboarding (create org + first-manager
  // invite). Same provider+reason guard as the reads. Echoes a result with
  // a dev invite token so the success screen can render it.
  setMockHandler('POST', '/api/v1/provider/tenants', (req, body) => {
    const cookieHeader = req.headers.cookie ?? '';
    const hasProviderToken = /(?:^|;\s*)provider_access_token=([^;]+)/.test(cookieHeader);
    if (!hasProviderToken) return { status: 401, body: { error: { code: 'invalid_token' } } };
    const reason = req.headers['access_reason'];
    if (!reason || (typeof reason === 'string' && reason.trim().length === 0)) {
      return { status: 400, body: { error: { code: 'reason_required' } } };
    }
    let parsed: { orgName?: string; managerEmail?: string } = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      /* fall through to a 400-shaped empty echo */
    }
    return {
      status: 200,
      body: {
        data: {
          orgId: '00000000-0000-4000-8000-0000000000b1',
          slug: 'new-pilot-org-abc123def456',
          orgName: parsed.orgName ?? 'New Pilot Org',
          managerEmail: parsed.managerEmail ?? 'manager@example.test',
          inviteToken: 'e2e-dev-invite-token',
        },
      },
    };
  });

  // /provider/system-health — the provider dashboard home page fires
  // this on mount via useProviderSystemHealth(). Mock returns a clean
  // gauge snapshot so the page renders without errors.
  setMockHandler('GET', '/api/v1/provider/system-health', (req) => {
    const cookieHeader = req.headers.cookie ?? '';
    const hasProviderToken = /(?:^|;\s*)provider_access_token=([^;]+)/.test(cookieHeader);
    if (!hasProviderToken) {
      return { status: 401, body: { error: { code: 'invalid_token' } } };
    }
    const reason = req.headers['access_reason'];
    if (!reason) {
      return { status: 400, body: { error: { code: 'reason_required' } } };
    }
    return {
      status: 200,
      body: {
        data: {
          queue: { created: 0, active: 0, retry: 0, failed: 0, completed: 10 },
          pool: {
            app: { total: 5, idle: 3, waiting: 0 },
            provider: { total: 2, idle: 2, waiting: 0 },
          },
          r2: { errorsSinceBoot: 0, lastErrorAt: null },
          timestamp: new Date().toISOString(),
        },
      },
    };
  });

  // /provider/tenants/:id — detail (D.37) + D.49 suspension state.
  // Registered per seed-id (the mock map is exact-path). Reflects the
  // cross-process `suspendedTenants` set so the suspend → refetch flip
  // is observable in the e2e (§AXIS-V).
  for (const seed of SEED_PROVIDER_TENANTS) {
    const guardProvider = (req: IncomingMessage) => {
      const cookieHeader = req.headers.cookie ?? '';
      const hasProviderToken = /(?:^|;\s*)provider_access_token=([^;]+)/.test(cookieHeader);
      if (!hasProviderToken) return { status: 401, body: { error: { code: 'invalid_token' } } };
      const reason = req.headers['access_reason'];
      if (!reason || (typeof reason === 'string' && reason.trim().length === 0)) {
        return { status: 400, body: { error: { code: 'reason_required' } } };
      }
      return null;
    };

    setMockHandler('GET', `/api/v1/provider/tenants/${seed.id}`, (req) => {
      const denied = guardProvider(req);
      if (denied) return denied;
      const suspended = suspendedTenants.has(seed.id);
      return {
        status: 200,
        body: {
          data: {
            id: seed.id,
            name: seed.name,
            slug: seed.slug,
            createdAt: seed.createdAt,
            archivedAt: seed.archivedAt,
            suspendedAt: suspended ? '2026-05-25T10:00:00.000Z' : null,
            suspendedReason: suspended ? 'e2e freeze' : null,
            counts: { ...seed.counts, importJobs: 0, signatureRequests: 0 },
            sampleOwners: [],
          },
        },
      };
    });

    setMockHandler('POST', `/api/v1/provider/tenants/${seed.id}/suspend`, (req) => {
      const denied = guardProvider(req);
      if (denied) return denied;
      suspendedTenants.add(seed.id);
      return {
        status: 200,
        body: {
          data: {
            id: seed.id,
            suspended: true,
            suspendedAt: '2026-05-25T10:00:00.000Z',
            suspendedReason: 'e2e freeze',
          },
        },
      };
    });

    setMockHandler('POST', `/api/v1/provider/tenants/${seed.id}/reactivate`, (req) => {
      const denied = guardProvider(req);
      if (denied) return denied;
      suspendedTenants.delete(seed.id);
      return {
        status: 200,
        body: {
          data: { id: seed.id, suspended: false, suspendedAt: null, suspendedReason: null },
        },
      };
    });
  }
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
      // D.49 — clear cross-process suspension state so each test starts
      // from a clean (active) tenant.
      suspendedTenants.clear();
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
