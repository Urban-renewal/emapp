/**
 * §E-J21 — Contractor read-view (D2-DEF-1 / D.46).
 *
 *   /he/contractor/share/<token>  →  project + AGGREGATE progress +
 *   structural buildings/apartments + shared documents + download.
 *
 * Pins the scope-critical FE contract:
 *   - The page is PUBLIC (token in URL is the credential; no org cookie) —
 *     it renders without a login bounce.
 *   - AGGREGATE progress only (counts/%); structural apartments; shared docs.
 *   - NO owner PII anywhere in the DOM (there is no owner endpoint).
 *
 * The contractor /contractor/* reads are stubbed via page.route (Bearer).
 */
import { test, expect } from './fixtures';

// JWT-shaped token so the middleware treats the route as PUBLIC.
const TOKEN = 'aaaaaa.bbbbbb.cccccc';
const CLEARTEXT_NID = '203456789';

test.describe('§E-J21 — contractor read-view (D.46)', () => {
  test('1) public read-view renders project + aggregate progress + docs; NO owner PII', async ({
    page,
    consoleErrors,
  }) => {
    await page.route('**/api/v1/contractor/project', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            project: {
              id: '00000000-0000-4000-8000-0000000000f1',
              name: 'תמ"א 38 הרצל',
              status: 'gathering_signatures',
              type: 'tama38_2',
            },
            buildings: [
              {
                id: '00000000-0000-4000-8000-0000000000f2',
                address: 'הרצל 1',
                city: 'תל אביב',
                block: '6941',
                parcel: '120',
                apartments: [
                  {
                    id: '00000000-0000-4000-8000-0000000000f3',
                    number: '4',
                    floor: 2,
                    rooms: 3,
                    sizeSqm: 80,
                    unitType: 'residential',
                    entrance: 'א',
                  },
                ],
              },
            ],
            permissions: { overview: true, documents: true, signatures: true },
          },
        }),
      });
    });
    await page.route('**/api/v1/contractor/progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { signaturesSigned: 58, signaturesPending: 42, signaturesTotal: 100 },
        }),
      });
    });
    await page.route('**/api/v1/contractor/documents', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: '00000000-0000-4000-8000-0000000000f4',
              name: 'תוכנית בנייה משותפת',
              type: 'plan',
              mimeType: 'application/pdf',
              sizeBytes: 2048,
              createdAt: '2026-05-20T10:00:00.000Z',
            },
          ],
        }),
      });
    });

    await page.goto(`/he/contractor/share/${TOKEN}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // §AXIS-V — project name renders (page is public; no login bounce).
    await expect(page.getByRole('heading', { name: /הרצל/ })).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain('/contractor/share/');

    // Aggregate progress: bar + "58 of 100 (58%)".
    await expect(page.getByText(/58.*100.*58%/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '58');

    // Structural building + shared document visible.
    await expect(page.getByText(/הרצל 1/)).toBeVisible();
    await expect(page.getByText('תוכנית בנייה משותפת')).toBeVisible();

    // §SCOPE — no owner PII anywhere (there is no owner endpoint at all).
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(CLEARTEXT_NID);
    expect(page.url()).not.toContain(CLEARTEXT_NID);

    expect(consoleErrors.count, 'no console errors on contractor read-view').toBe(0);
  });

  test('2) an invalid/expired token → the whole-page "invalid link" message', async ({ page }) => {
    await page.route('**/api/v1/contractor/project', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid_token' } }),
      });
    });
    await page.route('**/api/v1/contractor/**', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid_token' } }),
      });
    });
    await page.goto(`/he/contractor/share/${TOKEN}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page.getByText(/הקישור אינו תקף/)).toBeVisible({ timeout: 15_000 });
  });
});
