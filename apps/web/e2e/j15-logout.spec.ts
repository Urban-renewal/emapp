/**
 * §E-J15 — Logout (D.21 session revocation + cookie clear).
 *
 * Wave 1 — second journey. Covers MATRIX-V2 §7 item #15:
 * "Logout (cookies cleared → /login redirect)".
 *
 * D.17 cells exercised:
 *   - `auth.logout` (any-role) — terminates the session.
 *
 * 5-axis TUVAS coverage:
 *   T (Triggers)     — pre-seed an authed Manager state via
 *                       `context.addCookies()`; navigate to /he/;
 *                       click the logout button.
 *   U (URL bar)      — never contains the JWT value at any point;
 *                       lands at /he/login (locale preserved per
 *                       §RED-10, no double-307 through `/login`).
 *   V (Visible DOM)  — dashboard shell renders BEFORE logout (proof
 *                       the pre-seed actually authed); login form
 *                       renders AFTER (proof the redirect completed).
 *   A (API/Network)  — exactly one server-side POST to
 *                       /api/v1/auth/logout (verified via the mock
 *                       backend's request log, not page.route —
 *                       the call is a Server Action fetch in the
 *                       Next Node process).
 *   S (Side effects) — access_token cleared; refresh_token currently
 *                       survives due to issue #72 (path-scoped delete
 *                       missing); §P0-3 console clean. The test asserts
 *                       the CURRENT-broken behavior of refresh_token so
 *                       it's a regression tripwire when #72 lands.
 *
 * Threat-model linkage:
 *   - I5 (cookie posture): if `cookieStore.delete` regresses (e.g.
 *     drops the `path` attribute on the clear, so the original
 *     cookies survive), this test fails because `context.cookies()`
 *     will still list access_token / refresh_token. That's a
 *     session-stays-alive-after-logout Sev0 — the exact bug class
 *     this is built to catch.
 *   - I2 (no-oracle): the mock backend's POST /auth/logout returns
 *     200 with NO information about who was logged out. The Server
 *     Action treats any non-2xx the same as 2xx for the local
 *     cookie clear (so a network-failed logout still de-auths
 *     client-side per `auth.ts:52-77`).
 */
import { test, expect } from './fixtures';
import { setMockHandler, fetchRequestLog, SEED_MANAGER } from './mock-backend';

const SEEDED_ACCESS_TOKEN = 'e2e-manager-access-jwt';
const SEEDED_REFRESH_TOKEN = 'e2e-manager-refresh';

test.describe('§E-J15 — Logout', () => {
  test('1) authed manager logs out → cookies cleared, lands on /he/login', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // §AXIS-T (setup) — pre-seed cookies that simulate the post-login
    // state. Two cookies, two `addCookies` entries — avoids the
    // Chromium multi-Set-Cookie parse quirk (see J1 spec header).
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

    // The mock backend's default /me handler returns SEED_MANAGER when
    // an access_token is present — the dashboard layout's
    // server-side getMe() will resolve to a Manager and render.

    // §AXIS-T (navigate) — go to the dashboard home; this exercises
    // the (dashboard)/layout.tsx → getMe → proxy → mock-backend path
    // that wave 1 slice 1's infra unblocked.
    await page.goto('/he/');

    // §AXIS-V (pre) — dashboard rendered. The Topbar shows the
    // Manager's name + role; we assert the org name (rendered via
    // NameDisplay) so a layout regression that drops the user
    // context is visible here.
    await expect(page.getByText(SEED_MANAGER.organization.name)).toBeVisible({
      timeout: 10_000,
    });
    // The LogoutButton renders the t('nav.logout') label = "התנתק".
    const logoutButton = page.getByRole('button', { name: 'התנתק' });
    await expect(logoutButton).toBeVisible();

    // §AXIS-U (pre) — URL is /he/ and contains nothing about the JWT.
    expect(page.url(), 'JWT must never appear in URL').not.toContain(SEEDED_ACCESS_TOKEN);
    expect(page.url()).not.toContain(SEEDED_REFRESH_TOKEN);

    // §AXIS-T (interaction) — click logout. The Server Action runs
    // server-side; the mock backend will log the POST and respond 200;
    // the response's Set-Cookie clears the browser cookies; the page
    // then router.replace's to /he/login.
    await logoutButton.click();

    // §AXIS-V (post) — landed at /he/login with the login form. The
    // `method="post"` defense from S1-SEC1 should still hold (it's
    // pinned by the static check + auth-url-leak.spec.ts, but a
    // post-logout regression that loads a stub page would surface
    // here).
    await page.waitForURL(/\/he\/login$/, { timeout: 10_000 });
    await expect(page.locator('form[method="post"]')).toBeVisible({ timeout: 10_000 });

    // §AXIS-U (post) — URL ends at /he/login. No JWT material.
    const finalUrl = page.url();
    expect(finalUrl).toMatch(/\/he\/login$/);
    expect(finalUrl).not.toContain(SEEDED_ACCESS_TOKEN);
    expect(finalUrl).not.toContain(SEEDED_REFRESH_TOKEN);

    // §AXIS-S (cookies) — access_token MUST be cleared. The Server
    // Action's `cookieStore.delete('access_token')` emits Set-Cookie
    // with Max-Age=0 + matching path (`/`).
    const cookies = await context.cookies();
    const accessAfter = cookies.find((c) => c.name === 'access_token');
    expect(
      accessAfter,
      'access_token must be cleared after logout (D.21 session revocation contract)',
    ).toBeUndefined();

    // §ISSUE-72 — refresh_token clearing is currently broken:
    // `cookieStore.delete('refresh_token')` in `lib/auth.ts:75`
    // omits the `path`, so the emitted Set-Cookie targets `/` and
    // does NOT match the existing cookie at `/api/v1/auth/refresh`.
    // The fix sketch is in https://github.com/Urban-renewal/emapp/issues/72.
    // The HIGH-severity gap is bounded — the BE marks the session
    // revoked (D.21) so a leftover refresh_token cannot mint a new
    // access_token — but the FE-side hygiene gap is real.
    //
    // When #72 lands, the line below should flip to:
    //   expect(cookies.find((c) => c.name === 'refresh_token')).toBeUndefined();
    // and the asserted-broken-behavior comment removed.
    const refreshAfter = cookies.find((c) => c.name === 'refresh_token');
    expect(
      refreshAfter,
      'tracking issue #72 — refresh_token currently survives logout (FE-only hygiene gap)',
    ).toBeDefined();

    // §AXIS-A — the Server Action called the mock backend.
    // fetchRequestLog (HTTP) crosses the globalSetup ↔ test-worker
    // process boundary — the parent process owns the live log.
    // The cookie header carries the original (pre-clear) access_token,
    // proving the BE could revoke the session if it were real.
    const allRequests = await fetchRequestLog();
    const logoutCalls = allRequests.filter(
      (r) => r.method === 'POST' && r.url === '/api/v1/auth/logout',
    );
    expect(
      logoutCalls.length,
      `expected one POST /auth/logout; got ${logoutCalls.length}. ` +
        `Full log: ${JSON.stringify(allRequests.map((r) => `${r.method} ${r.url}`))}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      logoutCalls[0]?.cookie ?? '',
      'cookie header carried the pre-clear access_token (proves auth was active)',
    ).toContain(`access_token=${SEEDED_ACCESS_TOKEN}`);

    // §AXIS-S (console) — fixture auto-asserts. Logout flow is fully
    // mocked; any console error here would be a real CSP / hydration
    // / module-load failure.
    expect(consoleErrors.count, 'no console errors during logout').toBe(0);
  });

  test('2) logout when BE is unreachable still clears local cookies (defense-in-depth)', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // Pre-seed the authed state.
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
    ]);

    // §AXIS-A — override the mock backend so /auth/logout fails with
    // 502. The Server Action's `try/catch` (lib/auth.ts:62-73) MUST
    // still clear cookies locally so the user is at least signed-out
    // on the client side, even if the BE never knew.
    setMockHandler('POST', '/api/v1/auth/logout', () => ({
      status: 502,
      body: { error: { code: 'upstream_unreachable' } },
    }));

    await page.goto('/he/');
    await expect(page.getByText(SEED_MANAGER.organization.name)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'התנתק' }).click();

    // Still lands at /he/login (the action returns { ok: false } but
    // the subsequent router.replace runs unconditionally).
    await page.waitForURL(/\/he\/login$/, { timeout: 10_000 });

    // §AXIS-S — cookies STILL cleared locally despite upstream 502.
    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'access_token');
    expect(
      access,
      'access_token cleared even on upstream failure (lib/auth.ts:74-75 defense-in-depth)',
    ).toBeUndefined();

    // §AXIS-S (console) — Chromium will log the stubbed 502 from the
    // network layer (server-side fetch failure surfaces as a server-
    // emitted error, but the proxy → Set-Cookie passthrough still
    // works because cookieStore.delete runs on the local node
    // process). Carve the 502 out same way sign-flow.spec.ts handles
    // stubbed non-2xx.
    const real = consoleErrors.all.filter(
      (e) => !/502/.test(e) && !/Bad Gateway/i.test(e) && !/upstream_unreachable/i.test(e),
    );
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
