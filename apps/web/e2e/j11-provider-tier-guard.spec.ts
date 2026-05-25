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
 * away (the FE-side defense-in-depth mirroring D.29 tier isolation
 * + D.37 read-only Provider scope).
 *
 * Server-side check (provider/layout.tsx:42-45):
 *   if (!user || user.role !== 'provider_admin') redirect('/');
 *
 * The redirect target is '/' which then goes through next-intl
 * middleware → /he/ (dashboard home).
 *
 * D.17 cells exercised:
 *   - Provider tier role gate (cosmetic seam over D.29 BE isolation).
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; navigate to /he/provider.
 *   U — final URL is /he/ (the safe surface), NOT /he/provider.
 *   V — Manager dashboard renders (sidebar visible); no provider
 *       page chrome leaks pre-redirect.
 *   A — no /api/v1/provider/* calls reach the BE (FE-side guard
 *       prevents the request entirely).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

test.describe('§E-J11 — Provider tier guard (non-provider redirected)', () => {
  test('1) Manager → /he/provider redirected to /he/ (FE role guard)', async ({
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
        // a non-provider context surfaces here. The FE role guard is
        // cosmetic; the BE ProviderAuthGuard rejects org-tier JWTs
        // anyway, but the FE should not even attempt the call.
        providerApiHits += 1;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto('/he/provider');

    // §AXIS-U — landed on /he/ (the safe surface after the redirect
    // from provider/layout.tsx:42-45 → middleware locale-prepends).
    await page.waitForURL(/\/he\/?$/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/he\/?$/);
    // Crucially, NOT on /he/provider.
    expect(page.url()).not.toContain('/he/provider');

    // §AXIS-V — the dashboard sidebar is rendered (proves we landed
    // on the org-tier shell, not a half-rendered provider page).
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 10_000 });
    // The Manager's sidebar shows Members + Audit (Phase 4c S1/S4
    // role-gating per sidebar.tsx:80-86) — but NEVER the Provider
    // link (D.37: org-tier users don't see provider nav).
    const sidebar = page.getByRole('navigation');
    await expect(sidebar.getByRole('link', { name: 'מטה Provider' })).toBeHidden();

    // §AXIS-A — no provider-API calls fired. FE-side guard prevented
    // the request from leaving the browser.
    expect(providerApiHits, 'no /api/v1/provider/* calls from a non-provider context').toBe(0);

    expect(consoleErrors.count, 'no console errors on tier-guard redirect').toBe(0);
  });

  test('2) Viewer → /he/provider/tenants redirected to /he/', async ({
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

    // Deeper provider path — same guard applies (the layout wraps
    // every page under /he/provider).
    await page.goto('/he/provider/tenants');
    await page.waitForURL(/\/he\/?$/, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/he\/?$/);
    expect(page.url()).not.toContain('/he/provider');

    expect(consoleErrors.count, 'no console errors on tier-guard redirect').toBe(0);
  });
});
