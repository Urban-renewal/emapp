/**
 * §E-J2b — Manager creates a building under a project (step 2/5).
 *
 * Wave 1 slice 7 — second step of MATRIX-V2 §7 item #2 hierarchy
 * (J2a project create shipped in slice 6). J2c–J2e land alongside
 * stateful chain extensions in later slices.
 *
 * D.17 cells exercised:
 *   - `buildings.create` (Manager-only per policy.ts).
 *
 * Contract under test:
 *   - Form route is `/he/projects/:projectId/buildings/new`.
 *   - POST target is `/api/v1/projects/:projectId/buildings`.
 *   - Body matches `CreateBuildingInput.strict()` — required:
 *     address + city; optional: block + parcel + subparcel + notes.
 *   - On 201, the page redirects to `/he/buildings/<NEW_ID>`.
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; fill required + optional fields;
 *       submit.
 *   U — URL stays on /buildings/new during submit; redirects to
 *       /buildings/<id> after. Field values NOT in URL bar.
 *   V — `<form method="post">` SSR attribute; detail page renders.
 *   A — exactly one POST `/projects/<projectId>/buildings`; body
 *       carries the filled fields; strict-shape compliant.
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const PROJECT_ID = '00000000-0000-4000-8000-000040040001';
const NEW_BUILDING_ID = '00000000-0000-4000-8000-b000b000b001';

const FORM_VALUES = {
  address: 'הרצל 10',
  city: 'תל אביב',
  block: '6212',
  parcel: '88',
  subparcel: '1',
  notes: 'בניין 8 קומות, 16 דירות',
} as const;

test.describe('§E-J2b — Manager creates a building', () => {
  test('1) submit form → POST + redirect to /buildings/<id>', async ({
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

    let postCount = 0;
    let capturedBody: string | null = null;

    // Benign catch-all.
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // POST /projects/<id>/buildings — the call we OWN.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/buildings`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postCount += 1;
      capturedBody = route.request().postData();
      const now = new Date().toISOString();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_BUILDING_ID,
            projectId: PROJECT_ID,
            address: FORM_VALUES.address,
            city: FORM_VALUES.city,
            block: FORM_VALUES.block,
            parcel: FORM_VALUES.parcel,
            subparcel: FORM_VALUES.subparcel,
            aptCount: 0,
            notes: FORM_VALUES.notes,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    // GET /buildings/<NEW_ID> — detail page lands here post-redirect.
    await page.route(`**/api/v1/buildings/${NEW_BUILDING_ID}`, async (route) => {
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_BUILDING_ID,
            projectId: PROJECT_ID,
            address: FORM_VALUES.address,
            city: FORM_VALUES.city,
            block: FORM_VALUES.block,
            parcel: FORM_VALUES.parcel,
            subparcel: FORM_VALUES.subparcel,
            aptCount: 0,
            notes: FORM_VALUES.notes,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.goto(`/he/projects/${PROJECT_ID}/buildings/new`);
    await expect(page).toHaveURL(new RegExp(`/he/projects/${PROJECT_ID}/buildings/new$`));

    // §AXIS-V — SSR HTML carries method="post".
    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    expect((await form.getAttribute('method'))?.toLowerCase()).toBe('post');

    // §AXIS-T — fill required + optional fields.
    await page.locator('input#address').fill(FORM_VALUES.address);
    await page.locator('input#city').fill(FORM_VALUES.city);
    await page.locator('input#block').fill(FORM_VALUES.block);
    await page.locator('input#parcel').fill(FORM_VALUES.parcel);
    await page.locator('input#subparcel').fill(FORM_VALUES.subparcel);
    await page.locator('textarea#notes').fill(FORM_VALUES.notes);

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/projects/${PROJECT_ID}/buildings`) &&
          r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // §AXIS-A — exactly one POST.
    expect(postCount, 'exactly one POST /buildings').toBe(1);
    const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
    expect(body['address']).toBe(FORM_VALUES.address);
    expect(body['city']).toBe(FORM_VALUES.city);
    expect(body['block']).toBe(FORM_VALUES.block);
    expect(body['parcel']).toBe(FORM_VALUES.parcel);
    expect(body['subparcel']).toBe(FORM_VALUES.subparcel);
    expect(body['notes']).toBe(FORM_VALUES.notes);

    // §AXIS-V/U — navigated to detail page.
    await page.waitForURL(new RegExp(`/he/buildings/${NEW_BUILDING_ID}$`), {
      timeout: 10_000,
    });
    expect(page.url()).toMatch(new RegExp(`/he/buildings/${NEW_BUILDING_ID}$`));

    // §AXIS-U — URL bar does NOT carry field values.
    expect(page.url()).not.toContain(encodeURIComponent(FORM_VALUES.address));
    expect(page.url()).not.toContain(encodeURIComponent(FORM_VALUES.city));
    expect(page.url()).not.toMatch(/[?&](address|city|block|parcel|notes)=/);

    // §AXIS-S (console) — fixture auto-asserts.
    expect(consoleErrors.count, 'no console errors during create').toBe(0);
  });
});
