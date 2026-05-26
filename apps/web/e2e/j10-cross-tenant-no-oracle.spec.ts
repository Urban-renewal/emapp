/**
 * §E-J10 — Cross-tenant no-oracle (UUID from another org → 404 not 403).
 *
 * Wave 1 slice 4 — covers MATRIX-V2 §7 item #10:
 * "Cross-tenant no-oracle (Org A → Org B URL → 404)".
 *
 * The no-oracle contract is one of the most security-critical
 * invariants in the system (ARCHITECTURE-MAP §3 error catalog):
 *
 *   For any record-id-bearing endpoint, a cross-org id MUST return
 *   `{ error: { code: 'not_found' } }` (404) — NEVER `forbidden`
 *   (403). A 403 leaks the EXISTENCE of the record in another
 *   tenant, which is a structural enumeration channel.
 *
 *   `withTenant(orgId, fn)` enforces this at the DB layer via RLS:
 *   the SELECT returns 0 rows, the service throws NotFoundException,
 *   the controller maps to 404. The FE consumer MUST display the
 *   neutral "not found" copy with no hint that the record may exist
 *   elsewhere.
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; navigate to /he/projects/<UUID>
 *       with a foreign UUID; stub /projects/<UUID> as 404.
 *   U — URL contains the UUID (that's expected — the user typed/
 *       clicked it). What MUST NOT happen: a redirect that reveals
 *       different handling (e.g. /forbidden vs /not-found pages).
 *   V — neutral "הפרויקט לא נמצא" copy renders. NO "forbidden",
 *       "no access", "permission denied" copy.
 *   A — exactly one GET /projects/<UUID> request; the FE does not
 *       PROBE additional endpoints (e.g. /projects/<UUID>/buildings)
 *       on 404 — that would be its own oracle.
 *   S — no cookies churn; console clean (stubbed 404 carved out).
 */
import { test, expect } from './fixtures';

// A UUID that's syntactically valid (passes the BE Zod validator)
// but lives in "another tenant" from the perspective of the
// authed Manager (mock-backend's SEED_MANAGER's org).
const FOREIGN_UUID = '00000000-0000-4000-8000-deadbeefcafe';

test.describe('§E-J10 — Cross-tenant no-oracle', () => {
  test('1) foreign-org project id → 404 "not found", no enumeration', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // §AXIS-T (setup) — authed Manager. The org is SEED_MANAGER's
    // (the alpha-dev fixture); the FOREIGN_UUID belongs to a
    // different org (in real life that would be a separate
    // organization row; in this mock we don't care since the
    // stubbed BE returns 404 unconditionally).
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

    let projectFetchCount = 0;
    const otherEndpointFetches: string[] = [];

    // §AXIS-A — count every project-shape endpoint hit. If the FE
    // probes additional endpoints (e.g. /buildings on 404), they
    // surface here.
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === `/api/v1/projects/${FOREIGN_UUID}`) {
        projectFetchCount += 1;
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'not_found', message: 'project not found' },
          }),
        });
        return;
      }
      if (path.startsWith(`/api/v1/projects/${FOREIGN_UUID}/`)) {
        // The FE probed a SUB-resource of the 404'd project — that's
        // an enumeration channel. Record + return 404 so the test
        // can fail loudly downstream.
        otherEndpointFetches.push(path);
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'not_found', message: 'project not found' },
          }),
        });
        return;
      }
      // Benign catch-all (notifications etc).
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto(`/he/projects/${FOREIGN_UUID}`);

    // §AXIS-V — the neutral notFound copy renders. The detail page's
    // useProject hook catches ApiClientError with code='not_found'
    // and shows t('projects.notFound') = "הפרויקט לא נמצא".
    await expect(page.getByText('הפרויקט לא נמצא')).toBeVisible({ timeout: 15_000 });

    // §AXIS-V — NO enumeration-revealing copy. We assert each
    // forbidden-style word in HE and EN.
    await expect(page.getByText(/forbidden/i)).toBeHidden();
    await expect(page.getByText(/אסור/)).toBeHidden();
    await expect(page.getByText(/אין הרשאה/)).toBeHidden();
    await expect(page.getByText(/permission denied/i)).toBeHidden();
    // The neutral loadFailed copy MUST NOT show either — that would
    // hint at "the project exists but we can't load it".
    await expect(page.getByText('טעינת הרשימה נכשלה')).toBeHidden();

    // §AXIS-U — URL bar may legitimately carry the UUID (it's the
    // user-typed path). But it must not have gained query/hash that
    // hint at the error type.
    expect(page.url()).toContain(FOREIGN_UUID);
    expect(page.url()).not.toMatch(/[?&](error|reason|code)=/);

    // §AXIS-A — /projects/<id> is hit 1-4 times: the initial fetch
    // plus up to 3 TanStack Query retries (query-provider.tsx:35 sets
    // `retry: 3` on all queries; 404s are not exempted today). The
    // no-oracle contract is HONORED — every retry hits the SAME
    // resource id and gets the SAME `not_found`; no sub-resource
    // probing. If a future closure adds "no-retry-on-4xx" to the
    // query config, this bound tightens to exactly 1.
    expect(
      projectFetchCount,
      `/projects/<id> hit ${projectFetchCount}× (≤4: 1 initial + 3 TanStack retries)`,
    ).toBeGreaterThanOrEqual(1);
    expect(projectFetchCount).toBeLessThanOrEqual(4);
    expect(
      otherEndpointFetches,
      `FE probed sub-resources after 404 (no-oracle violation): ${otherEndpointFetches.join(', ')}`,
    ).toEqual([]);

    // §AXIS-S (console) — Chromium logs the stubbed 404 from the
    // network panel; carve it out (same pattern as J1 test 2 + sign-flow).
    const real = consoleErrors.all.filter((e) => !/\b404\b/.test(e) && !/Not Found/i.test(e));
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });

  test('2) "back to list" link from notFound returns to /he/projects', async ({
    page,
    context,
    consoleErrors,
  }) => {
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
      if (url.pathname === `/api/v1/projects/${FOREIGN_UUID}`) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'not_found', message: 'project not found' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto(`/he/projects/${FOREIGN_UUID}`);
    await expect(page.getByText('הפרויקט לא נמצא')).toBeVisible({ timeout: 15_000 });

    // §AXIS-T — click the "back to list" CTA (t('projects.backToList')).
    // The HE label is "חזרה לרשימה" (per messages/he.json projects).
    await page.getByRole('button', { name: /חזרה לרשימה/ }).click();

    // §AXIS-U — landed on /he/projects (the safe surface).
    await page.waitForURL(/\/he\/projects$/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/he\/projects$/);

    const real = consoleErrors.all.filter((e) => !/\b404\b/.test(e) && !/Not Found/i.test(e));
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
