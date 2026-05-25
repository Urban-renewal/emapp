/**
 * §P0-3 — Dev console clean test.
 *
 * WHY THIS EXISTS:
 * PR #43 shipped with a CSP `unsafe-eval` block that prevented JS
 * hydration in dev. `@next/react-refresh-utils` fires an EvalError on
 * every page load when CSP blocks `eval()`. Effect: all forms fell back
 * to native HTML GET → credentials in URL on every dev environment.
 * The bug passed all prior E2E tests because none of them asserted a
 * clean console — they only checked HTTP status codes and UI elements.
 *
 * THE FIX (§P0-3 in `fix/phase-4a-dev-blockers`):
 * `next.config.ts` now adds `'unsafe-eval'` to `script-src` ONLY when
 * `NODE_ENV !== 'production'`. Prod stays strict. Dev works.
 *
 * THIS TEST:
 * Loads every main route in dev mode and asserts ZERO console errors or
 * page exceptions. This is the CI guardrail that would have caught P0-3
 * before it merged.
 *
 * Routes tested (using Playwright's page.route() stubs — no live BE):
 *  - /he/login   — public auth page
 *  - /he/signup  — public auth page
 *
 * Dashboard routes (require auth cookie) are tested in auth.spec.ts
 * once that suite is extended; for now this covers the most critical
 * path (login form CSP hydration) that was the P0-3 root cause.
 */
import { test, expect } from './fixtures';

test.describe('§P0-3 — dev console clean (no CSP eval-block)', () => {
  test('1) /he/login — zero console errors on page load', async ({ page, consoleErrors }) => {
    // Stub /api/* so we don't need a live BE.
    await page.route('**/api/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: null }),
      }),
    );

    await page.goto('/he/login');
    // Wait for the page to hydrate — the login form should be visible.
    await expect(page.locator('form')).toBeVisible({ timeout: 10_000 });

    // The fixture auto-asserts consoleErrors.count === 0 in afterEach.
    // But also assert here so the failure message is pinned to this test.
    expect(consoleErrors.count).toBe(0);
  });

  test('2) /he/signup — zero console errors on page load', async ({ page, consoleErrors }) => {
    await page.route('**/api/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: null }),
      }),
    );

    await page.goto('/he/signup');
    await expect(page.locator('form')).toBeVisible({ timeout: 10_000 });
    expect(consoleErrors.count).toBe(0);
  });
});
