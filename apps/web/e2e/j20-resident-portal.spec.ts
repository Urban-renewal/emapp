/**
 * §E-J20 — Resident portal (D2 S5): own MASKED PII (D.47) + AGGREGATE
 * project progress (counts/%, never another resident's data).
 *
 * Asserts the two scope-critical contracts on the rendered page:
 *   - D.47 — the resident's own national_id/phone render MASKED; the
 *     cleartext 9-digit national_id NEVER appears in the DOM or URL.
 *   - AGGREGATE progress — the progress section shows "X of Y (Z%)" with
 *     a progressbar; no other resident's id/name/PII is present.
 *
 * Auth: the (tenant) layout only checks the `tenant_access_token` cookie;
 * the 5 portal GETs are client fetches stubbed via page.route.
 */
import { test, expect } from './fixtures';

const CLEARTEXT_NID = '203456789';
const MASKED_NID = '•••••••89';
const MASKED_PHONE = '•••••4567';
const OTHER_RESIDENT_NID = '111111118';

test.describe('§E-J20 — resident portal (D.47 masking + aggregate progress)', () => {
  test('1) own PII is masked; progress is aggregate; no cleartext / no other resident', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await context.addCookies([
      {
        name: 'tenant_access_token',
        value: 'e2e-tenant-access-jwt',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    const stub = (path: string, body: unknown) =>
      page.route(`**/api/v1/portal/${path}`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      });

    // /me — masked PII only (D.47).
    await stub('me', {
      data: {
        id: '00000000-0000-4000-8000-0000000000d1',
        organizationId: '00000000-0000-4000-8000-000000000002',
        name: 'דוד תנעמי',
        email: 'david@example.test',
        nationalIdMasked: MASKED_NID,
        phoneMasked: MASKED_PHONE,
        createdAt: '2026-05-20T10:00:00.000Z',
      },
    });
    await stub('apartment', { data: [] });
    await stub('documents', { data: [] });
    await stub('signatures', { data: [] });
    // /progress — aggregate counts only.
    await stub('progress', {
      data: [
        {
          projectId: '00000000-0000-4000-8000-0000000000e1',
          projectName: 'תמ"א 38 הרצל',
          status: 'gathering_signatures',
          signaturesSigned: 58,
          signaturesPending: 42,
          signaturesTotal: 100,
        },
      ],
    });
    // Benign catch-all (notifications etc.).
    await page.route('**/api/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/v1/portal/')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto('/he/portal', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // §AXIS-V — masked national_id rendered.
    await expect(page.getByText(MASKED_NID)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(MASKED_PHONE)).toBeVisible();

    // §SCOPE — the cleartext national_id must NOT appear anywhere in the DOM.
    const fullText = await page.locator('body').innerText();
    expect(fullText).not.toContain(CLEARTEXT_NID);
    // No other resident's identifier leaks into the resident's own view.
    expect(fullText).not.toContain(OTHER_RESIDENT_NID);
    // §AXIS-U — cleartext never in the URL.
    expect(page.url()).not.toContain(CLEARTEXT_NID);

    // §AXIS-V — aggregate progress: summary + progressbar (counts only).
    await expect(page.getByText(/58.*100.*58%/)).toBeVisible({ timeout: 10_000 });
    const bar = page.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '58');

    expect(consoleErrors.count, 'no console errors on portal').toBe(0);
  });
});
