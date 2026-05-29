/**
 * §FUNC-3 — bare `/he/buildings` and `/he/apartments` must NOT dead-end on
 * Next's raw 404. Neither entity has a global list view (buildings are
 * scoped to a project, apartments to a building), so the index segment had
 * no `page.tsx` and a bare visit 404'd. The fix adds redirect-only index
 * pages that send the user to the projects hub (the parent of the
 * project → building → apartment hierarchy).
 *
 * Verification (mechanism, not a 404-status check a friendly error page
 * could also pass): after navigating to the bare URL the browser must LAND
 * on `/he/projects` and render the real projects surface (the "צור פרויקט"
 * action) — i.e. an actual redirect to a working page, not a styled 404.
 */
import { test, expect } from './fixtures';

const MANAGER_COOKIE = {
  name: 'access_token',
  value: 'e2e-manager-access-jwt',
  domain: 'localhost',
  path: '/',
  httpOnly: true,
  sameSite: 'Lax' as const,
  secure: false,
};

test.describe('§FUNC-3 — bare list routes redirect to the projects hub', () => {
  for (const bare of ['/he/buildings', '/he/apartments']) {
    test(`${bare} → redirect to /he/projects (not a raw 404)`, async ({
      page,
      context,
      consoleErrors,
    }) => {
      await context.addCookies([MANAGER_COOKIE]);

      // Benign catch-all for the browser-side list/notification fetches the
      // projects page makes after it renders.
      await page.route('**/api/v1/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
        });
      });

      await page.goto(bare);

      // §mechanism — the redirect lands on the projects hub.
      await page.waitForURL(/\/he\/projects$/, { timeout: 15_000 });
      expect(page.url()).toMatch(/\/he\/projects$/);

      // …and it is the real projects surface, not a styled 404 page: the
      // create-project link (href="/projects/new") is unique to the list.
      await expect(page.getByRole('link', { name: 'צור פרויקט' })).toBeVisible({
        timeout: 10_000,
      });

      expect(consoleErrors.count, 'no console errors during redirect').toBe(0);
    });
  }
});
