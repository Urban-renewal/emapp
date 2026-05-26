/**
 * §E-J11 — Provider Admin tier guard (negative control).
 *
 * Wave 1 slice 7 — partial coverage of MATRIX-V2 §7 item #11:
 * "Provider Admin — Login + MFA + tenants browse + audit row".
 *
 * Scope note: the POSITIVE control (a Provider Admin successfully
 * browses /he/provider/tenants) requires mock-backend SEED_PROVIDER
 * support + AccessReasonGate sessionStorage prefill — both larger
 * infra extensions. THIS slice pins the NEGATIVE control: a
 * non-Provider user navigating to /he/provider MUST be redirected
 * away (the middleware tier-isolation guard mirroring D.29 +
 * D.37 read-only Provider scope).
 *
 * V10-S2/S3 update — the redirect target is now /he/provider/login
 * (NOT /he/). Before V10-S2 there was no /provider/login page, so the
 * middleware bounced unauthenticated /provider/* visits to /he/login
 * (org login). With the page in place, the tier-appropriate target is
 * the provider login — so a non-provider user (whether unauthenticated
 * or org-authenticated) is sent there to acquire a provider session.
 *
 * Middleware tier-isolation rule (middleware.ts V10-S4):
 *   /<locale>/provider/* requires provider_access_token. Anything else
 *   redirects to /<locale>/provider/login.
 *
 * D.17 cells exercised:
 *   - Provider tier cookie gate (middleware + layout defense in depth).
 *
 * 5-axis TUVAS:
 *   T — pre-seed org cookies; navigate to /he/provider.
 *   U — final URL is /he/provider/login, NOT /he/provider (the data
 *       subtree). Verified the user did NOT reach the dashboard.
 *   V — provider login form renders; no provider data chrome leaks
 *       pre-redirect.
 *   A — no /api/v1/provider/* calls fired (middleware tier-guard
 *       prevented the request entirely; layout never ran).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

test.describe('§E-J11 — Provider tier guard (non-provider redirected)', () => {
  test('1) Manager → /he/provider redirected to /he/provider/login (V10-S2)', async ({
    page,
    context,
    consoleErrors,
  }) => {
    let providerApiHits = 0;

    await context.addCookies([
      {
        name: 'access_token',
        value: 'e2e-manager-access-jwt',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/provider/')) {
        // §AXIS-A — a regression that called provider endpoints from
        // a non-provider context surfaces here. The middleware tier-
        // guard MUST prevent the layout from running before any
        // provider API call has a chance to fire.
        providerApiHits += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto('/he/provider');

    // §AXIS-U — landed on /he/provider/login (V10-S2 tier-appropriate
    // target). NOT inside /he/provider data subtree.
    await page.waitForURL(/\/he\/provider\/login$/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/he\/provider\/login$/);
    // Crucially, NOT a deeper provider data path like /he/provider/tenants.
    expect(page.url()).not.toMatch(/\/he\/provider\/(tenants|audit|system-health)/);

    // §AXIS-V — the provider login form renders. The login title
    // i18n key is `auth.providerLoginTitle` — Hebrew copy:
    // "כניסה למסוף Provider".
    await expect(page.getByRole('heading', { name: /Provider/i })).toBeVisible({
      timeout: 10_000,
    });
    // The MFA field is the unambiguous marker of the provider login
    // (org login has no MFA today; D.21 — MFA is provider-tier only).
    await expect(page.locator('input#mfa_code')).toBeVisible();

    // §AXIS-A — no provider-API calls fired. The middleware redirect
    // ran BEFORE any layout / page / hook could mount.
    expect(providerApiHits, 'no /api/v1/provider/* calls from a non-provider context').toBe(0);

    expect(consoleErrors.count, 'no console errors on tier-guard redirect').toBe(0);
  });

  test('2) Viewer → /he/provider/tenants redirected to /he/provider/login (V10-S2)', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await context.addCookies([
      {
        name: 'access_token',
        value: 'e2e-viewer-access-jwt',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // Deeper provider path — the middleware tier-guard applies the
    // same way (URL anchor matches /he/provider/<anything>).
    await page.goto('/he/provider/tenants');
    await page.waitForURL(/\/he\/provider\/login$/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/he\/provider\/login$/);
    // The data subtree URL is gone.
    expect(page.url()).not.toContain('/he/provider/tenants');

    expect(consoleErrors.count, 'no console errors on tier-guard redirect').toBe(0);
  });

  test('3) Unauthenticated visitor → /he/provider redirected to /he/provider/login (no cookies)', async ({
    page,
    consoleErrors,
  }) => {
    // No cookies set. Middleware tier-guard sends unauthenticated
    // visitors to the provider login (was /he/login pre-V10-S2;
    // the tier-appropriate target keeps the operator inside the
    // tier context).
    await page.goto('/he/provider');
    await page.waitForURL(/\/he\/provider\/login$/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/he\/provider\/login$/);

    // Provider login form renders.
    await expect(page.locator('input#mfa_code')).toBeVisible({ timeout: 10_000 });
    expect(consoleErrors.count, 'no console errors on unauth redirect').toBe(0);
  });
});
