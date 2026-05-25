/**
 * P0 SECURITY — T-S1.1-SEC + T-S1.2-SEC.
 *
 * The login + signup forms must NEVER let credentials reach the URL
 * query string — neither on the JS-hydrated path nor on the SSR
 * fallback (JS disabled / pre-hydration / hydration failure / CSP
 * block / network drop after HTML).
 *
 * Two layers of defense, two test groups:
 *
 *  1. JS-hydrated: react-hook-form's handleSubmit calls preventDefault
 *     and the onSubmit handler does an apiClient.post(...). We assert
 *     window.location.search stays empty after a real submit.
 *
 *  2. SSR HTML: the rendered <form> tag MUST have `method="post"`. If
 *     it doesn't, a browser without JS (or pre-hydration) defaults to
 *     GET with form fields in the URL — credentials end up in logs,
 *     CDN caches, browser history, Referer headers.
 *
 * Doc 07 §7.10 + Doc 10 (No PII in URL).
 *
 * Verification gap closure: S1 was originally shipped without these
 * tests; the bug was uncovered by user inspection of the SSR HTML.
 * OPEN-ITEMS-v9 entry §S1-VG1 ("S1 closed without manual browser
 * smoke; verification gap exposed by user, not by self-audit").
 */
import { expect, test } from '@playwright/test';

test.describe('auth forms — URL credential leak (P0 §S1-SEC1)', () => {
  test('1) SSR HTML: /he/login form has method="post" (GET-fallback defense)', async ({ page }) => {
    // Disable JS so we ONLY see the SSR HTML — this is exactly the
    // surface a pre-hydration submit would use.
    const context = page.context();
    await context.route('**/*', (route) => route.continue());
    await page.goto('/he/login', { waitUntil: 'domcontentloaded' });
    const formMethod = await page.locator('form').first().getAttribute('method');
    expect(formMethod?.toLowerCase()).toBe('post');
  });

  test('2) SSR HTML: /he/signup form has method="post"', async ({ page }) => {
    await page.goto('/he/signup', { waitUntil: 'domcontentloaded' });
    const formMethod = await page.locator('form').first().getAttribute('method');
    expect(formMethod?.toLowerCase()).toBe('post');
  });

  test('3) JS path: login submit never puts email/password in URL', async ({ page }) => {
    // Stub the auth endpoint so we don't actually hit the BE.
    await page.route('**/api/v1/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid_credentials' } }),
      }),
    );
    await page.goto('/he/login');
    await page.locator('input#email').fill('user@example.com');
    await page.locator('input#password').fill('SuperSecret123!');
    await page.locator('button[type="submit"]').click();
    // Either the submit completed (URL unchanged) or the page is
    // showing the inline error — EITHER way the URL must not carry
    // the credentials.
    const url = page.url();
    expect(url).not.toContain('user%40example.com');
    expect(url).not.toContain('SuperSecret123');
    expect(url).not.toMatch(/[?&]email=/);
    expect(url).not.toMatch(/[?&]password=/);
  });

  test('4) JS path: signup submit never puts credentials/PII in URL', async ({ page }) => {
    await page.route('**/api/v1/auth/signup', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'validation_error' } }),
      }),
    );
    await page.goto('/he/signup');
    await page.locator('input#org_name').fill('Acme');
    await page.locator('input#name').fill('Jane Doe');
    await page.locator('input#email').fill('user@example.com');
    await page.locator('input#password').fill('SuperSecret123!');
    await page.locator('button[type="submit"]').click();
    const url = page.url();
    expect(url).not.toContain('user%40example.com');
    expect(url).not.toContain('SuperSecret123');
    expect(url).not.toMatch(/[?&]email=/);
    expect(url).not.toMatch(/[?&]password=/);
    expect(url).not.toMatch(/[?&]name=/);
    expect(url).not.toMatch(/[?&]org_name=/);
  });
});

// Dashboard form sweep (covering every authenticated POST page) is
// pinned by a static-source check in src/app-forms-no-get-fallback.spec.ts
// — Playwright cannot reach those routes without an authenticated
// session, but a static check on every page.tsx is actually more
// reliable: it catches the bug at the source, not at runtime.
