/**
 * Phase 4a S11 — Playwright E2E: middleware + public-route surface.
 *
 * Scope (LEAN): the security-critical assertion that S10 introduces is
 *   "the JWT-shape regex correctly bypasses the auth gate, and any
 *    OTHER path under /sign falls through to /he/login."
 * This file pins exactly that behavior. End-to-end UI flow against the
 * public sign page (preview → canvas → submit) is deferred to a later
 * slice that pairs Playwright with a real BE fixture — the per-test
 * `page.route()` stubs we tried hit a SSR-hydration race in headless
 * dev that isn't worth solving inside S11.
 *
 * What we ARE testing here is the unauthenticated, no-fetch security
 * surface — the middleware's PUBLIC_LOCALE_AGNOSTIC_REGEX. Vitest
 * already covers the regex (middleware.spec.ts M11-M15), but Playwright
 * exercises the live Next.js middleware against a real Chromium client
 * — defense in depth.
 *
 * Critical-path coverage:
 *   1. Malformed token → /he/login redirect (middleware enforces shape).
 *   2. Two-segment "fake JWT" → /he/login redirect (anchoring works).
 *   3. Valid JWT shape → page loads (no redirect; useEffect handles the
 *      rest server-side, out of E2E scope).
 *   4. Login page renders (sanity: dev server boots + middleware
 *      doesn't bounce /he/login).
 */
import { expect, test } from '@playwright/test';

// Valid JWT shape: three base64url segments joined by `.`
const VALID_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';

test.describe('public middleware surface — S10', () => {
  test('1) malformed single-segment token redirects to /he/login', async ({ page }) => {
    await page.goto('/sign/not-a-jwt-token');
    await expect(page).toHaveURL(/\/he\/login$/);
  });

  test('2) two-segment "fake JWT" redirects to /he/login (anchoring works)', async ({ page }) => {
    await page.goto('/sign/header.payload');
    await expect(page).toHaveURL(/\/he\/login$/);
  });

  test('3) valid JWT shape bypasses the auth gate (URL stays on /sign/<jwt>)', async ({ page }) => {
    await page.goto(`/sign/${VALID_JWT}`, { waitUntil: 'commit' });
    await expect(page).toHaveURL(new RegExp(`/sign/${VALID_JWT}$`));
  });
});

test.describe('locale routing — sanity', () => {
  test('4) /he/login renders the login page (no auth-gate bounce)', async ({ page }) => {
    await page.goto('/he/login');
    await expect(page).toHaveURL(/\/he\/login$/);
  });
});
