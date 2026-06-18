/**
 * §E-J16 — Provider Admin tenant SUSPEND / REACTIVATE (D.49 writes).
 *
 * Companion to j11 (read happy-path). Pins the D2 slice-1 write flow:
 *
 *   /he/provider/tenants/:id  →  "Suspend" → note form → confirm
 *   →  POST /provider/tenants/:id/suspend  →  detail refetch
 *   →  suspended badge + Reactivate button appear
 *   →  "Reactivate" (window.confirm) → POST .../reactivate → flip back
 *
 * 4-axis browser-smoke (FE DoD — DOD-BROWSER-SMOKE.md):
 *   Network — the mutation is a POST to .../suspend|/reactivate (never a
 *     GET); verified via the server-side request log (same source of
 *     truth as j11; page.route races the proxy→mock chain).
 *   URL     — the operator note NEVER lands in the URL; the page stays on
 *     the detail route across the whole flow (no GET-fallback leak).
 *   Cookies — the write POST carries `provider_access_token` (otherwise
 *     the mock 401s and the UI never flips).
 *   Redirect— no navigation away from the detail page; the state change
 *     is reflected in-place via TanStack cache invalidation.
 *
 * State: the mock-backend holds a cross-process `suspendedTenants` set,
 * cleared by the `fetchResetRequestLog()` beforeEach — so each test
 * starts from an active tenant and the suspend→refetch flip is real.
 */
import { test, expect } from './fixtures';
import { fetchRequestLog, fetchResetRequestLog, SEED_PROVIDER_TENANTS } from './mock-backend';

const REASON = 'Suspend review — ticket TKT-8888';
const TENANT = SEED_PROVIDER_TENANTS[0]!;
const DETAIL_PATH = `/he/provider/tenants/${TENANT.id}`;

async function seedSession(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
) {
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
  // sessionStorage must be set on the same origin — visit a provider
  // page first, then set the reason, then nav into the detail route.
  await page.goto('/he/provider');
  await page.evaluate(
    ([key, value]) => {
      window.sessionStorage.setItem(key as string, value as string);
    },
    ['emapp.provider.access_reason', REASON],
  );
}

test.describe('§E-J16 — provider suspend / reactivate (D.49)', () => {
  test.beforeEach(async () => {
    await fetchResetRequestLog();
  });

  test('1) Suspend with note → POST fires, badge flips, URL clean, cookie attached', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedSession(page, context);
    await page.goto(DETAIL_PATH);

    // §AXIS-V — detail renders (tenant name visible) and the panel offers
    // "Suspend" (tenant is active by default).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
    const suspendBtn = page.getByRole('button', { name: 'השעה לקוח' });
    await expect(suspendBtn).toBeVisible({ timeout: 10_000 });

    // Reveal the inline note form, type an operator note.
    await suspendBtn.click();
    const note = page.locator('textarea#suspend-note');
    await expect(note).toBeVisible();
    await note.fill('אי-תשלום');

    // §AXIS-U — the note must NOT have leaked into the URL.
    expect(page.url()).not.toContain('suspend-note');
    expect(page.url()).not.toContain(encodeURIComponent('אי-תשלום'));

    // Confirm the suspend → POST fires.
    await page.getByRole('button', { name: 'אשר השעיה' }).click();

    // §AXIS-V — after the refetch the suspended badge + Reactivate appear.
    await expect(page.getByText('מושעה', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'החזר לפעולה' })).toBeVisible();

    // §AXIS-U — still on the detail page; nothing leaked to the URL.
    expect(page.url()).toContain(`/provider/tenants/${TENANT.id}`);
    expect(page.url()).not.toContain('suspend');

    // §AXIS-A + Cookies — exactly one suspend POST, carrying the cookie.
    const log = await fetchRequestLog();
    const suspendCalls = log.filter(
      (r) => r.url === `/api/v1/provider/tenants/${TENANT.id}/suspend`,
    );
    expect(suspendCalls.length, 'one suspend POST').toBe(1);
    expect(suspendCalls[0]!.method).toBe('POST');
    expect(suspendCalls[0]!.cookie).toContain('provider_access_token=');

    // §AXIS-Network — the write was NEVER issued as a GET (no credential/
    // state leak via query string).
    const suspendGets = log.filter(
      (r) =>
        r.url.startsWith(`/api/v1/provider/tenants/${TENANT.id}/suspend`) && r.method === 'GET',
    );
    expect(suspendGets.length, 'no GET to the suspend endpoint').toBe(0);

    expect(consoleErrors.count, 'no console errors on suspend flow').toBe(0);
  });

  test('2) Reactivate → POST fires, badge clears, stays on detail page', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedSession(page, context);

    // Arrange: suspend first so the page loads in the suspended state.
    await page.goto(DETAIL_PATH);
    await page.getByRole('button', { name: 'השעה לקוח' }).click();
    await page.getByRole('button', { name: 'אשר השעיה' }).click();
    await expect(page.getByRole('button', { name: 'החזר לפעולה' })).toBeVisible({
      timeout: 10_000,
    });

    // F-1: reactivate now raises the styled in-DOM ConfirmDialog (not a native
    // window.confirm) — click the dialog's confirm button to release the POST.
    await page.getByRole('button', { name: 'החזר לפעולה' }).click();
    await page.getByRole('button', { name: 'אישור' }).click();

    // §AXIS-V — badge clears; the Suspend action returns.
    await expect(page.getByRole('button', { name: 'השעה לקוח' })).toBeVisible({ timeout: 10_000 });

    // §AXIS-U — still on the detail route.
    expect(page.url()).toContain(`/provider/tenants/${TENANT.id}`);

    // §AXIS-A + Cookies — a reactivate POST fired with the cookie.
    const log = await fetchRequestLog();
    const reCalls = log.filter((r) => r.url === `/api/v1/provider/tenants/${TENANT.id}/reactivate`);
    expect(reCalls.length, 'one reactivate POST').toBeGreaterThanOrEqual(1);
    expect(reCalls[0]!.method).toBe('POST');
    expect(reCalls[0]!.cookie).toContain('provider_access_token=');

    expect(consoleErrors.count, 'no console errors on reactivate flow').toBe(0);
  });
});
