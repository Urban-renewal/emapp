/**
 * §E-J17 — Provider Admin ONBOARDING (D.45): create Org + first-manager invite.
 *
 * Pins the D2 slice-2 write flow:
 *   /he/provider/onboard  →  fill org/manager fields  →  submit
 *   →  POST /provider/tenants  →  success screen with the dev invite token
 *
 * 4-axis browser-smoke (FE DoD):
 *   Network — the create is a POST to /provider/tenants (never a GET).
 *   URL     — the manager email / org name NEVER land in the URL (no
 *     GET-fallback leak); the page stays on /provider/onboard.
 *   Cookies — the POST carries `provider_access_token`.
 *   Redirect— no navigation away mid-submit; the success state renders in
 *     place. The "back to tenants" button is an explicit user action.
 */
import { test, expect } from './fixtures';
import { fetchRequestLog, fetchResetRequestLog } from './mock-backend';

const REASON = 'Onboard pilot customer — ticket TKT-7777';
const MANAGER_EMAIL = 'first.manager@example.test';

test.describe('§E-J17 — provider onboarding (D.45)', () => {
  test.beforeEach(async () => {
    await fetchResetRequestLog();
  });

  test('1) Create org + first manager → POST fires, token shown, URL clean, cookie attached', async ({
    page,
    context,
    consoleErrors,
  }) => {
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
    await page.goto('/he/provider');
    await page.evaluate(
      ([key, value]) => {
        window.sessionStorage.setItem(key as string, value as string);
      },
      ['emapp.provider.access_reason', REASON],
    );
    await page.goto('/he/provider/onboard');

    // §AXIS-V — the form renders.
    await expect(page.locator('input#orgName')).toBeVisible({ timeout: 10_000 });

    await page.locator('input#orgName').fill('פיילוט התחדשות');
    await page.locator('input#managerName').fill('דנה מנהלת');
    await page.locator('input#managerEmail').fill(MANAGER_EMAIL);

    // §AXIS-U — nothing in the URL before submit.
    expect(page.url()).not.toContain(MANAGER_EMAIL);
    expect(page.url()).not.toContain(encodeURIComponent('פיילוט התחדשות'));

    await page.getByRole('button', { name: 'צור והזמן' }).click();

    // §AXIS-V — success screen with the dev invite token textarea.
    await expect(page.locator('textarea#invite-token')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('textarea#invite-token')).toHaveValue('e2e-dev-invite-token');

    // §AXIS-U — still on the onboard route; manager email never in the URL.
    expect(page.url()).toContain('/provider/onboard');
    expect(page.url()).not.toContain(MANAGER_EMAIL);

    // §AXIS-A + Cookies — exactly one create POST, carrying the cookie.
    const log = await fetchRequestLog();
    const createCalls = log.filter(
      (r) => r.url === '/api/v1/provider/tenants' && r.method === 'POST',
    );
    expect(createCalls.length, 'one create POST').toBe(1);
    expect(createCalls[0]!.cookie).toContain('provider_access_token=');

    // §AXIS-Network — never a GET to the create endpoint (no query leak).
    const createGets = log.filter(
      (r) =>
        r.url.startsWith('/api/v1/provider/tenants') && r.method === 'GET' && !r.url.includes('?'),
    );
    // (a GET /provider/tenants list is legitimate elsewhere; here the onboard
    // page issues none, so assert no GET hit the bare collection during submit.)
    expect(createGets.length, 'no GET to the create endpoint during onboarding').toBe(0);

    expect(consoleErrors.count, 'no console errors on onboarding flow').toBe(0);
  });
});
