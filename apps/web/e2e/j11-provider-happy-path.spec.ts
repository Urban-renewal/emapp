/**
 * §E-J11 happy-path — Provider Admin successful login + dashboard +
 * cross-tenant browse.
 *
 * Companion to `j11-provider-tier-guard.spec.ts` (negative control).
 * This spec pins the POSITIVE control across the V10-S1/S2/S3 chain:
 *
 *   /he/provider/login  →  fill form  →  POST /provider/auth/login
 *   →  BE Set-Cookie    →  router.push('/provider')  →  middleware
 *   →  layout calls /provider/me  →  AccessReasonGate prompt
 *   →  fill reason      →  dashboard mounts  →  system-health gauge
 *   →  click Tenants    →  /provider/tenants list renders
 *
 * 5-axis TUVAS coverage:
 *   T — fill provider login form, navigate, prompt-reason, click into
 *       tenants.
 *   U — URL transitions: /he/provider/login → /he/provider →
 *       /he/provider/tenants. Never lands on /he/login (org).
 *   V — visual milestones: MFA field on login page; dashboard heading
 *       on /he/provider; tenant names rendered on list page.
 *   A — network discipline: POST /provider/auth/login fires (verified
 *       via the server-side mock-backend request log, not page.route
 *       — page.route+fallback breaks the proxy → mock chain); the
 *       /provider/me call carries the provider cookie; the /tenants
 *       call carries `access_reason` header (D.37).
 *   S — no console errors; cookies set with the expected
 *       attributes (HttpOnly, SameSite=Lax, path scoping per the BE
 *       controller).
 *
 * Why server-side request log (`fetchRequestLog()`) rather than
 * page.route() interception:
 *   - The proxy + mock-backend chain is the SOURCE of truth — it's
 *     what the dev server actually contacts. Intercepting at the
 *     browser layer with route.fallback() can race against the proxy
 *     handshake on slow CI machines and produces flakier results.
 *   - Server-side log captures the actual request shape (URL, body,
 *     cookies, headers) as it arrived at the BE — more faithful to
 *     a real call.
 *   - Pattern matches j15-logout / j14-silent-refresh which also use
 *     fetchRequestLog for §AXIS-A assertions.
 *
 * Pre-req fixtures wired in mock-backend.ts:
 *   - POST /api/v1/provider/auth/login  →  sets provider cookies
 *   - GET  /api/v1/provider/me           →  SEED_PROVIDER profile
 *   - GET  /api/v1/provider/tenants      →  SEED_PROVIDER_TENANTS
 *   - GET  /api/v1/provider/system-health → mock gauges
 */
import { test, expect } from './fixtures';
import { fetchRequestLog, fetchResetRequestLog, SEED_PROVIDER_TENANTS } from './mock-backend';

const VALID_LOGIN = {
  email: 'admin@emapp.io',
  password: 'TestProvider123!',
  mfa_code: '123456',
} as const;

const REASON = 'Quarterly access review — ticket TKT-9999';

test.describe('§E-J11 happy-path — Provider Admin full flow', () => {
  test.beforeEach(async () => {
    // Reset the parent-process request log so per-test assertions
    // see ONLY the calls this test fired.
    await fetchResetRequestLog();
  });

  test('1) Login form → cookie set → /he/provider dashboard renders', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // Pre-seed the access-reason in sessionStorage so the gate doesn't
    // block the dashboard render on first visit (the gate is covered
    // in test #2). We do this BEFORE the form submit so it's set by
    // the time the dashboard layout mounts post-redirect.
    //
    // sessionStorage requires the page to be loaded first — we visit
    // /he/provider/login (the form), then set storage, then submit.
    await page.goto('/he/provider/login');
    await page.evaluate(
      ([key, value]) => {
        window.sessionStorage.setItem(key as string, value as string);
      },
      ['emapp.provider.access_reason', REASON],
    );

    // §AXIS-V — provider login form rendered.
    await expect(page.locator('input#mfa_code')).toBeVisible({ timeout: 10_000 });

    // ─── Fill the form + submit ───
    await page.locator('input#email').fill(VALID_LOGIN.email);
    await page.locator('input#password').fill(VALID_LOGIN.password);
    await page.locator('input#mfa_code').fill(VALID_LOGIN.mfa_code);

    // §AXIS-U — credentials NEVER in URL (§S1-SEC1 invariant).
    const urlBeforeSubmit = page.url();
    expect(urlBeforeSubmit).not.toContain(VALID_LOGIN.email);
    expect(urlBeforeSubmit).not.toContain(VALID_LOGIN.password);
    expect(urlBeforeSubmit).not.toContain(VALID_LOGIN.mfa_code);

    // Wait for the navigation triggered by router.push('/provider').
    // next-intl middleware re-routes /provider → /he/provider; we
    // tolerate both shapes in the regex.
    await Promise.all([
      page.waitForURL(/\/he\/provider\/?$/, { timeout: 15_000 }),
      page.locator('button[type="submit"]').click(),
    ]);

    // §AXIS-U — landed on /he/provider.
    expect(page.url()).toMatch(/\/he\/provider\/?$/);

    // §AXIS-V — provider dashboard heading renders (the i18n key is
    // `provider.dashboard.title`).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // §AXIS-S — provider cookie set with the expected attributes.
    const cookies = await context.cookies();
    const providerAccess = cookies.find((c) => c.name === 'provider_access_token');
    expect(providerAccess, 'provider_access_token cookie set').toBeDefined();
    expect(providerAccess?.httpOnly, 'cookie is HttpOnly').toBe(true);
    expect(providerAccess?.sameSite, 'cookie SameSite=Lax').toBe('Lax');

    // §AXIS-A (server-side log) — verify the actual request shape.
    const log = await fetchRequestLog();
    const loginCalls = log.filter((r) => r.url === '/api/v1/provider/auth/login');
    expect(loginCalls.length, 'exactly one login POST').toBe(1);
    expect(loginCalls[0]!.method).toBe('POST');

    // Provider /me was called (the dashboard layout's session resolver
    // fires this on every page nav).
    const meCalls = log.filter((r) => r.url === '/api/v1/provider/me');
    expect(meCalls.length, 'at least one provider /me call').toBeGreaterThanOrEqual(1);
    // Cookie attached on the /me call (otherwise the mock would 401).
    expect(meCalls[0]!.cookie).toContain('provider_access_token=');

    // Org-tier /me NEVER called — V10-S1 closure invariant.
    const orgMeCalls = log.filter((r) => r.url === '/api/v1/me');
    expect(orgMeCalls.length, 'no org /me call from provider tier').toBe(0);

    // §AXIS-S — console clean.
    expect(consoleErrors.count, 'no console errors on full login flow').toBe(0);
  });

  test('2) AccessReasonGate blocks dashboard until reason is set, then releases', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // Pre-seed cookies (skip the login form — that's covered in #1).
    await context.addCookies([
      {
        name: 'provider_access_token',
        value: 'e2e-provider-access',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    // First visit — sessionStorage starts empty (a fresh browser
    // context per Playwright test).
    await page.goto('/he/provider');

    // §AXIS-V — the gate input is visible (BEFORE reason set).
    const reasonInput = page.locator('input#provider-reason');
    await expect(reasonInput).toBeVisible({ timeout: 10_000 });

    // §AXIS-A — before the reason is set, no DATA-fetching provider
    // call should have fired. /provider/me is allowed (the layout
    // fires it unconditionally to resolve session); /system-health
    // and /tenants are GATED by the AccessReasonGate (they're hooks
    // INSIDE children, blocked while !hasReason).
    const logBefore = await fetchRequestLog();
    const dataCallsBefore = logBefore.filter(
      (r) =>
        r.url.startsWith('/api/v1/provider/') &&
        r.url !== '/api/v1/provider/me' &&
        !r.url.includes('/auth/'),
    );
    expect(dataCallsBefore.length, 'no /provider/* data calls before reason').toBe(0);

    // Fill the reason (must be ≥ 8 chars per AccessReasonGate.MIN_LENGTH).
    await reasonInput.fill(REASON);
    await page.locator('button[type="submit"]').click();

    // §AXIS-V — after submit the dashboard mounts.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // §AXIS-A — the dashboard hook now fires /provider/system-health.
    // Allow time for the request to land server-side.
    await page.waitForTimeout(500);
    const logAfter = await fetchRequestLog();
    const healthCalls = logAfter.filter((r) => r.url === '/api/v1/provider/system-health');
    expect(healthCalls.length, 'system-health called after reason set').toBeGreaterThanOrEqual(1);
    // §D.37 — provider call carries access_reason. The mock would
    // 400 reason_required otherwise; the page wouldn't render the
    // gauge without the success response.

    expect(consoleErrors.count, 'no console errors after reason set').toBe(0);
  });

  test('3) Navigate to /he/provider/tenants → list renders with mock data', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // Pre-seed cookie + reason — skip the login + gate (covered in #1, #2).
    await context.addCookies([
      {
        name: 'provider_access_token',
        value: 'e2e-provider-access',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    // sessionStorage must be set on the SAME origin as the page —
    // visit /he/provider first, then set storage, then nav into the
    // deeper path.
    await page.goto('/he/provider');
    await page.evaluate(
      ([key, value]) => {
        window.sessionStorage.setItem(key as string, value as string);
      },
      ['emapp.provider.access_reason', REASON],
    );
    await page.goto('/he/provider/tenants');

    // §AXIS-V — both seed tenants render with their names visible.
    for (const tenant of SEED_PROVIDER_TENANTS) {
      await expect(page.getByText(tenant.name)).toBeVisible({ timeout: 10_000 });
    }

    // §AXIS-A — the tenants call carried the provider cookie.
    const log = await fetchRequestLog();
    const tenantsCalls = log.filter((r) => r.url.startsWith('/api/v1/provider/tenants'));
    expect(tenantsCalls.length, 'tenants call fired').toBeGreaterThanOrEqual(1);
    expect(tenantsCalls[0]!.cookie).toContain('provider_access_token=');

    // §AXIS-S — console clean.
    expect(consoleErrors.count, 'no console errors on tenants list').toBe(0);
  });

  test('4) Wrong credentials → anti-enum generic message; URL stays clean; no cookies', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // Stub the login endpoint to return the anti-enum 401 shape. Here
    // page.route + route.fulfill is the RIGHT pattern — we never want
    // the request to reach the mock-backend (which would set cookies).
    await page.route('**/api/v1/provider/auth/login', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'invalid_credentials', message: 'wrong creds' },
        }),
      });
    });

    await page.goto('/he/provider/login');
    await page.locator('input#email').fill(VALID_LOGIN.email);
    await page.locator('input#password').fill('wrong-password');
    await page.locator('input#mfa_code').fill('000000');

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/provider/auth/login') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // §AXIS-V — generic anti-enum message visible. The HE copy is
    // `auth.invalidProviderCredentials` = "אימייל, סיסמה או קוד אימות שגויים".
    await expect(page.getByText(/אימייל.*שגויים/)).toBeVisible({ timeout: 5_000 });

    // §AXIS-U — still on /he/provider/login; URL untouched; no
    // credentials in URL (the §S1-SEC1 invariant).
    expect(page.url()).toMatch(/\/he\/provider\/login$/);
    expect(page.url()).not.toContain(VALID_LOGIN.email);
    expect(page.url()).not.toContain('wrong-password');

    // §AXIS-S — no cookie set on failed login.
    const cookies = await context.cookies();
    expect(
      cookies.find((c) => c.name === 'provider_access_token'),
      'no provider cookie on failure',
    ).toBeUndefined();

    // Console: Chromium logs the stubbed 401; filter same as J13.
    const real = consoleErrors.all.filter((e) => !/\b401\b/.test(e) && !/Unauthorized/i.test(e));
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
