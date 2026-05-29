/**
 * §E-J2d — Manager creates an owner (step 4/5 of hierarchy).
 *
 * Wave 1 slice 11 — fourth step of MATRIX-V2 §7 #2. J2e (ownerships
 * D.25 set-replace sum=100) lands as the final step.
 *
 * D.17 cells exercised:
 *   - `owners.create` (Manager-only per policy.ts).
 *
 * Threat-model linkage (D.19 PII):
 *   - `national_id` is PII. The form field has `inputMode="numeric"`
 *     + `autoComplete="off"` so it's never auto-stored by the
 *     browser's autofill. The submit body carries it (HTTPS only
 *     in prod); the URL bar MUST stay clean. The §S1-SEC1 SSR
 *     `method="post"` defense is even more critical here than for
 *     login — a GET-fallback would leak the national ID into
 *     server access logs + CDN caches + browser history.
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; fill name + national_id + phone;
 *       submit.
 *   U — URL never contains national_id or phone (PII).
 *   V — `<form method="post">` SSR attribute.
 *   A — exactly one POST /owners; body matches CreateOwnerInput
 *       (name + 9-digit national_id; phone optional).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const NEW_OWNER_ID = '00000000-0000-4000-8000-000000770044';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

// A fictitious-but-Luhn-valid Israeli national ID. The check digit
// for '99900044' is '1' (algorithm in packages/db/scripts/seed-dev.ts).
// FE Zod-validates the 9-digit regex; the BE-side MOD-10 refine
// would 400 otherwise.
const FORM_VALUES = {
  name: 'דנה כהן',
  national_id: '999000441',
  phone: '0501234567',
  email: 'dana@example.test',
} as const;

test.describe('§E-J2d — Manager creates an owner', () => {
  test('1) submit form → POST + redirect to /owners/<id>; national_id never in URL', async ({
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

    await page.route('**/api/v1/owners', async (route) => {
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
            id: NEW_OWNER_ID,
            organizationId: ORG_ID,
            name: FORM_VALUES.name,
            email: FORM_VALUES.email,
            nationalIdMasked: '•••••••44',
            phoneMasked: '•••••4567',
            notes: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.route(`**/api/v1/owners/${NEW_OWNER_ID}`, async (route) => {
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
            id: NEW_OWNER_ID,
            organizationId: ORG_ID,
            name: FORM_VALUES.name,
            email: FORM_VALUES.email,
            nationalIdMasked: '•••••••44',
            phoneMasked: '•••••4567',
            notes: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.goto('/he/owners/new');
    await expect(page).toHaveURL(/\/he\/owners\/new$/);

    // §AXIS-V — method="post" MUST be present (D.19 + S1-SEC1).
    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    expect((await form.getAttribute('method'))?.toLowerCase()).toBe('post');

    // §AXIS-T — fill fields including the PII national_id.
    await page.locator('input#name').fill(FORM_VALUES.name);
    await page.locator('input#national_id').fill(FORM_VALUES.national_id);
    await page.locator('input#phone').fill(FORM_VALUES.phone);
    await page.locator('input#email').fill(FORM_VALUES.email);

    // Click, then wait on the REDIRECT as the success signal — not on a
    // `waitForResponse` race. `onSubmit` only calls router.push after
    // `mutateAsync` resolves, so the navigation is causally downstream of
    // a captured POST: once the URL is the detail page, postCount/body are
    // guaranteed set by the route handler. The prior
    // `Promise.all([waitForResponse, click])` form flaked under cold-compile
    // load (same class fixed for j2 in PR #175).
    await page.locator('button[type="submit"]').click();

    // §AXIS-V/U — landed on detail page (success signal).
    await page.waitForURL(new RegExp(`/he/owners/${NEW_OWNER_ID}$`), { timeout: 15_000 });
    expect(page.url()).toMatch(new RegExp(`/he/owners/${NEW_OWNER_ID}$`));

    // §AXIS-A — wire-level assertions (guaranteed captured by the redirect).
    expect(postCount).toBe(1);
    const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
    expect(body['name']).toBe(FORM_VALUES.name);
    expect(body['national_id']).toBe(FORM_VALUES.national_id);
    expect(body['phone']).toBe(FORM_VALUES.phone);
    expect(body['email']).toBe(FORM_VALUES.email);

    // §AXIS-U (PII guard — D.19) — the URL MUST NOT contain
    // national_id or phone. A GET-fallback regression would surface
    // here loudly.
    const url = page.url();
    expect(url, 'national_id MUST NOT be in URL (D.19 PII)').not.toContain(FORM_VALUES.national_id);
    expect(url, 'phone MUST NOT be in URL (D.19 PII)').not.toContain(FORM_VALUES.phone);
    expect(url).not.toMatch(/[?&](national_id|phone|email)=/);

    expect(consoleErrors.count, 'no console errors during create').toBe(0);
  });

  // §FUNC-1 — the audit finding: an owner could NOT be created via the UI
  // without an email, because the untouched optional inputs submit `''`
  // and `email: z.string().email().optional()` / `phone: .min(9).optional()`
  // reject the empty string — the form silently refused to submit. This
  // test fills ONLY the required fields, leaves email + phone blank, and
  // asserts the POST fires with those fields OMITTED (not sent as ''), then
  // redirects. Before the `setValueAs: emptyToUndefined` fix this stays on
  // the form and never POSTs. The wire-body assertion (email/phone absent,
  // not '') is the mechanism a schema-loosening plaster would fail.
  test('2) owner WITHOUT email/phone → POST omits them → redirect (FUNC-1)', async ({
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

    await page.route('**/api/v1/owners', async (route) => {
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
            id: NEW_OWNER_ID,
            organizationId: ORG_ID,
            name: FORM_VALUES.name,
            email: null,
            nationalIdMasked: '•••••••44',
            phoneMasked: null,
            notes: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.route(`**/api/v1/owners/${NEW_OWNER_ID}`, async (route) => {
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
            id: NEW_OWNER_ID,
            organizationId: ORG_ID,
            name: FORM_VALUES.name,
            email: null,
            nationalIdMasked: '•••••••44',
            phoneMasked: null,
            notes: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.goto('/he/owners/new');
    await expect(page).toHaveURL(/\/he\/owners\/new$/);

    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });

    // §AXIS-T — fill ONLY the required fields; leave email + phone BLANK.
    await page.locator('input#name').fill(FORM_VALUES.name);
    await page.locator('input#national_id').fill(FORM_VALUES.national_id);

    await page.locator('button[type="submit"]').click();

    // Success signal — the form was submittable despite blank optionals.
    await page.waitForURL(new RegExp(`/he/owners/${NEW_OWNER_ID}$`), { timeout: 15_000 });
    expect(page.url()).toMatch(new RegExp(`/he/owners/${NEW_OWNER_ID}$`));

    // §AXIS-A — the POST fired exactly once, with email + phone OMITTED
    // (the fix maps '' → undefined). They must NOT be sent as empty strings.
    expect(postCount, 'POST fired despite blank optional fields').toBe(1);
    const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
    expect(body['name']).toBe(FORM_VALUES.name);
    expect(body['national_id']).toBe(FORM_VALUES.national_id);
    expect('email' in body, 'blank email omitted, not sent as ""').toBe(false);
    expect('phone' in body, 'blank phone omitted, not sent as ""').toBe(false);

    expect(consoleErrors.count, 'no console errors during create').toBe(0);
  });
});
