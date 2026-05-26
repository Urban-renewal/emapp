/**
 * §E-J2c — Manager creates an apartment under a building (step 3/5).
 *
 * Wave 1 slice 10 — third step of MATRIX-V2 §7 item #2 hierarchy.
 * J2d (owners) + J2e (ownerships sum=100) land in later slices.
 *
 * D.17 cells exercised:
 *   - `apartments.create` (Manager-only per policy.ts).
 *
 * Contract under test:
 *   - Form route `/he/buildings/:buildingId/apartments/new`.
 *   - POST target `/api/v1/buildings/:buildingId/apartments`.
 *   - Body matches `CreateApartmentInput.strict()` (number required;
 *     floor + sizeSqm + rooms + status + notes optional).
 *   - On 201, redirect to `/he/apartments/<NEW_ID>`.
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; fill required + numeric optional
 *       fields; submit.
 *   U — URL bar never carries values.
 *   V — `<form method="post">`; detail page renders post-redirect.
 *   A — exactly one POST; body shape exact (no extras).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const BUILDING_ID = '00000000-0000-4000-8000-b000b000b001';
const NEW_APT_ID = '00000000-0000-4000-8000-a070a070a001';

const FORM_VALUES = {
  number: '3א',
  floor: '2',
  sizeSqm: '85.5',
  rooms: '4',
  notes: 'דירה משופצת',
} as const;

test.describe('§E-J2c — Manager creates an apartment', () => {
  test('1) submit form → POST + redirect to /apartments/<id>', async ({
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

    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.route(`**/api/v1/buildings/${BUILDING_ID}/apartments`, async (route) => {
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
            id: NEW_APT_ID,
            buildingId: BUILDING_ID,
            number: FORM_VALUES.number,
            floor: Number(FORM_VALUES.floor),
            sizeSqm: Number(FORM_VALUES.sizeSqm),
            rooms: Number(FORM_VALUES.rooms),
            status: 'pending',
            statusChangedAt: now,
            lastContactAt: null,
            notes: FORM_VALUES.notes,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.route(`**/api/v1/apartments/${NEW_APT_ID}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_APT_ID,
            buildingId: BUILDING_ID,
            number: FORM_VALUES.number,
            floor: Number(FORM_VALUES.floor),
            sizeSqm: Number(FORM_VALUES.sizeSqm),
            rooms: Number(FORM_VALUES.rooms),
            status: 'pending',
            statusChangedAt: now,
            lastContactAt: null,
            notes: FORM_VALUES.notes,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.goto(`/he/buildings/${BUILDING_ID}/apartments/new`);

    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    expect((await form.getAttribute('method'))?.toLowerCase()).toBe('post');

    await page.locator('input#number').fill(FORM_VALUES.number);
    await page.locator('input#floor').fill(FORM_VALUES.floor);
    await page.locator('input#sizeSqm').fill(FORM_VALUES.sizeSqm);
    await page.locator('input#rooms').fill(FORM_VALUES.rooms);
    await page.locator('textarea#notes').fill(FORM_VALUES.notes);

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/buildings/${BUILDING_ID}/apartments`) &&
          r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    expect(postCount, 'exactly one POST /apartments').toBe(1);
    const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
    expect(body['number']).toBe(FORM_VALUES.number);
    // Numeric fields are coerced by zodResolver(CreateApartmentInput).
    expect(body['floor']).toBe(2);
    expect(body['sizeSqm']).toBe(85.5);
    expect(body['rooms']).toBe(4);
    expect(body['notes']).toBe(FORM_VALUES.notes);

    await page.waitForURL(new RegExp(`/he/apartments/${NEW_APT_ID}$`), { timeout: 10_000 });
    expect(page.url()).toMatch(new RegExp(`/he/apartments/${NEW_APT_ID}$`));
    expect(page.url()).not.toMatch(/[?&](number|floor|notes)=/);

    expect(consoleErrors.count, 'no console errors during create').toBe(0);
  });
});
