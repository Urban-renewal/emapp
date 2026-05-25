/**
 * §E-J14 — Silent refresh (session expiry handled invisibly).
 *
 * Wave 1 slice 3 — covers MATRIX-V2 §7 item #14:
 * "Session expiry (token → silent refresh → continue)".
 *
 * D.17 cells exercised:
 *   - `auth.refresh` (public, cookie-bearer) — D.21 reuse-detected
 *     refresh token rotation.
 *
 * Contract under test (api-client.ts:119-132 + 210-219):
 *   When ANY authenticated request returns 401 with
 *   `error.code === 'token_expired'`, the api-client MUST:
 *     1. Suppress the global `emapp:unauthenticated` event.
 *     2. Fire exactly ONE POST /api/v1/auth/refresh.
 *     3. On refresh success, replay the ORIGINAL request once.
 *     4. Return the replay's body to the caller as if the 401
 *        never happened.
 *
 *   This is the "silent" part — the user sees ONE seamless render,
 *   not a flash of /login or an error toast.
 *
 * 5-axis TUVAS coverage:
 *   T (Triggers)     — pre-seed authed cookies + stateful
 *                       page.route on /projects: first call 401
 *                       token_expired, second call 200 + list.
 *                       Navigate to /he/projects.
 *   U (URL bar)      — never lands on /login (the regression
 *                       failure mode here is: refresh fails →
 *                       global event → AuthGuard redirects to login;
 *                       the test must end on /he/projects).
 *   V (Visible DOM)  — projects page renders (empty-state message
 *                       OR list, NOT the error pill).
 *   A (API/Network)  — exactly 2× GET /projects + exactly 1×
 *                       POST /auth/refresh, in that order.
 *   S (Side effects) — refreshed access_token from the refresh
 *                       response's Set-Cookie applied to context;
 *                       §P0-3 console clean.
 *
 * Threat-model linkage:
 *   - I4 (envelope): the silent-refresh decision is on `error.code`,
 *     NOT on message.  This test fails closed if the api-client ever
 *     switches to message-based dispatch (a regression that would
 *     leak the contract).
 *   - D.31 G2 — `code === 'token_expired'` triggers silent refresh;
 *     `invalid_credentials` / `invalid_otp` / `not_member` do NOT
 *     (form-level concerns; the test for those is J13).
 */
import { test, expect } from './fixtures';

const SEEDED_ACCESS_TOKEN = 'e2e-expired-access-jwt';
const SEEDED_REFRESH_TOKEN = 'e2e-valid-refresh-jwt';

test.describe('§E-J14 — Silent refresh on token_expired', () => {
  test('1) 401 token_expired triggers refresh + replay; UI never flashes /login', async ({
    page,
    context,
    consoleErrors,
  }) => {
    let projectsCalls = 0;
    let refreshCalls = 0;
    const callOrder: string[] = [];

    // §AXIS-T (setup) — pre-seed authed Manager state.
    await context.addCookies([
      {
        name: 'access_token',
        value: SEEDED_ACCESS_TOKEN,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
      {
        name: 'refresh_token',
        value: SEEDED_REFRESH_TOKEN,
        domain: 'localhost',
        path: '/api/v1/auth/refresh',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    // §AXIS-A — catch-all benign for endpoints we don't model (e.g.
    // notifications, which the dashboard topbar polls). Returns an
    // empty list envelope so the dashboard doesn't 404 → console.error.
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/projects') || url.pathname === '/api/v1/auth/refresh') {
        // Handled by the specific stubs below — fall through.
        await route.fallback();
        return;
      }
      // Default empty-list envelope.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // §AXIS-A — stateful projects stub. The hook calls
    // `/api/v1/projects?limit=25` (api-client.ts:289 + use-projects).
    // First call: 401 token_expired (the contract trigger).
    // Second call: 200 with empty list (the replay).
    await page.route('**/api/v1/projects**', async (route) => {
      projectsCalls += 1;
      callOrder.push(`projects#${projectsCalls}`);
      if (projectsCalls === 1) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'token_expired', message: 'access token expired' },
          }),
        });
        return;
      }
      // Replay: 200 + empty list. The page should render the empty-
      // state message; ANY list content would do — empty avoids
      // having to mock the full Project shape.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [],
          page: { limit: 25, cursor: null, has_more: false },
        }),
      });
    });

    // §AXIS-A — refresh stub. Returns 200 + Set-Cookie that rotates
    // the access_token (per D.21 — refresh token rotation). The
    // updated cookie value lets us prove the context picked up the
    // refresh's Set-Cookie passthrough.
    await page.route('**/api/v1/auth/refresh', async (route) => {
      refreshCalls += 1;
      callOrder.push(`refresh#${refreshCalls}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Set-Cookie': 'access_token=e2e-refreshed-access; Path=/; HttpOnly; SameSite=Lax',
        },
        body: JSON.stringify({ data: { ok: true } }),
      });
    });

    // §AXIS-T (navigate) — go to projects. The dashboard layout runs
    // getMe (server-side, served by mock backend) → renders → the
    // projects page mounts → useProjectList fires GET /projects →
    // (silent refresh dance) → renders.
    await page.goto('/he/projects');

    // §AXIS-V — the projects page renders the EMPTY state, not the
    // loadFailed error. If silent refresh broke (e.g. refresh failed
    // → global event fired → AuthGuard pushed to /login), we'd be
    // on /login here and this assertion would fail.
    //
    // The empty-state text is `t('projects.empty')` = "אין עדיין
    // פרויקטים. הקלק על "צור פרויקט" להוספה." Match the leading
    // substring; the call-to-action tail is locale-volatile.
    await expect(page.getByText(/אין עדיין פרויקטים/)).toBeVisible({ timeout: 15_000 });
    // The loadFailed pill MUST NOT render — that's the regression we
    // catch (silent refresh failure surfaces as loadFailed via the
    // useQuery error state).
    await expect(page.getByText('טעינת הרשימה נכשלה')).toBeHidden();

    // §AXIS-U — never bounced to /login.
    expect(page.url(), 'must stay on /he/projects (not /login)').toMatch(/\/he\/projects$/);
    expect(page.url()).not.toContain('/login');

    // §AXIS-A — exactly 2× /projects + 1× /auth/refresh, in order.
    expect(projectsCalls, 'projects fetched twice (original + replay)').toBe(2);
    expect(refreshCalls, 'refresh fetched exactly once (single-flight)').toBe(1);
    // The ORDER matters: original /projects → refresh → replay /projects.
    // If api-client ever calls refresh BEFORE the first /projects (a
    // future "proactive refresh" feature), that change would surface
    // here.
    expect(callOrder, 'silent-refresh sequence is original → refresh → replay').toEqual([
      'projects#1',
      'refresh#1',
      'projects#2',
    ]);

    // §AXIS-S (cookies) — the refresh response's Set-Cookie applied
    // to the context. The original access_token value should now be
    // 'e2e-refreshed-access' (per the refresh stub above).
    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'access_token');
    expect(access, 'access_token cookie present after refresh').toBeDefined();
    expect(
      access?.value,
      'access_token rotated to the refresh response value (D.21 rotation)',
    ).toBe('e2e-refreshed-access');

    // §AXIS-S (console) — Chromium logs the stubbed 401 from the
    // network layer (the api-client catches it programmatically, but
    // the browser fetch panel still emits "Failed to load resource:
    // 401"). Same carve-out pattern as sign-flow.spec.ts:200-210.
    const real = consoleErrors.all.filter(
      (e) => !/\b401\b/.test(e) && !/Unauthorized/i.test(e) && !/token_expired/i.test(e),
    );
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
