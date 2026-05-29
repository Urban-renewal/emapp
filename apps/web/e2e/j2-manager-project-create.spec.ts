/**
 * §E-J2a — Manager creates a project (first step of the hierarchy).
 *
 * Wave 1 slice 6 — covers the CREATE-PROJECT step of MATRIX-V2 §7
 * item #2: "Manager — hierarchy (project → building → apt → owners
 * → ownerships sum=100)".
 *
 * Scope note: the full hierarchy is a 5-step BE-stateful flow; pinning
 * each step end-to-end requires either real seed-dev data or a stateful
 * mock-backend extension. Slice 6 ships the FIRST step (J2a) — proves
 * the create-form contract + redirect on success. J2b–J2e land in
 * later slices alongside the corresponding mock-backend extensions.
 *
 * D.17 cells exercised:
 *   - `projects.create` (Manager-only per policy.ts).
 *
 * Threat-model linkage:
 *   - I3 (PII never in URL): the project name + description are
 *     org-internal; not PII per se, but the same SSR `method="post"`
 *     defense from §S1-SEC1 applies. Field values MUST NOT appear
 *     in the URL bar.
 *   - I4 (envelope): success returns `{ data: Project }`; redirect to
 *     `/he/projects/<id>` happens client-side via router.push.
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; fill name + select type; submit.
 *   U — URL stays on /he/projects/new during submit, then navigates
 *       to /he/projects/<id> after success. NO field values in URL.
 *   V — `<form method="post">` (SSR defense); error pill hidden on
 *       success.
 *   A — exactly one POST /projects; body matches
 *       CreateProjectInput.strict() (name + type required).
 *   S — Idempotency-Key header present on the POST (api-client
 *       postIdempotent helper per §v9-P0-3); console clean.
 */
import { test, expect } from './fixtures';

const NEW_PROJECT_ID = '00000000-0000-4000-8000-000040040001';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

const FORM_VALUES = {
  name: 'תמ"א 38 — דוגמה',
  type: 'tama38_2',
  description: 'פיילוט להרצת הבדיקה האוטומטית.',
} as const;

test.describe('§E-J2a — Manager creates a project', () => {
  test('1) submit form → POST + redirect to /projects/<id>', async ({
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
    let idempotencyKey: string | null = null;
    let getDetailCount = 0;

    // Benign catch-all (notifications etc).
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // POST /projects — the call we OWN.
    await page.route('**/api/v1/projects', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postCount += 1;
      capturedBody = route.request().postData();
      idempotencyKey = await route.request().headerValue('Idempotency-Key');
      const now = new Date().toISOString();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_PROJECT_ID,
            organizationId: ORG_ID,
            name: FORM_VALUES.name,
            type: FORM_VALUES.type,
            status: 'planning',
            description: FORM_VALUES.description,
            targetSignaturePct: null,
            startedAt: null,
            createdBy: MANAGER_USER_ID,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            buildingsCount: 0,
            unitsCount: 0,
            signaturesPendingCount: 0,
            signaturesSignedCount: 0,
            agentsCount: 0,
          },
        }),
      });
    });

    // GET /projects/<NEW_ID> — the detail page that router.push lands
    // on. Stub a minimal successful response so the detail page
    // renders without 404'ing.
    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}`, async (route) => {
      getDetailCount += 1;
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_PROJECT_ID,
            organizationId: ORG_ID,
            name: FORM_VALUES.name,
            type: FORM_VALUES.type,
            status: 'planning',
            description: FORM_VALUES.description,
            targetSignaturePct: null,
            startedAt: null,
            createdBy: MANAGER_USER_ID,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            buildingsCount: 0,
            unitsCount: 0,
            signaturesPendingCount: 0,
            signaturesSignedCount: 0,
            agentsCount: 0,
          },
        }),
      });
    });

    await page.goto('/he/projects/new');
    await expect(page).toHaveURL(/\/he\/projects\/new$/);

    // §AXIS-V — SSR HTML must carry method="post" (defense in depth).
    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    expect((await form.getAttribute('method'))?.toLowerCase()).toBe('post');

    // §FUNC-4 — wait for the REAL hydration signal before touching any
    // field. The wizard is a client-only controlled-input form: filling
    // before React attaches its onChange handlers writes the DOM value
    // but never reaches React state, and the controlled re-render on
    // hydration then wipes the typed value — so the subsequent "הבא"
    // click sees an empty name, never advances, and the POST never
    // fires (waitForResponse times out). This was the flaky failure on
    // slow runners. `data-hydrated="true"` is set by a post-hydration
    // effect; gating on it (not a fixed timeout) makes the fill
    // deterministic. The nav/submit buttons are ALSO disabled until
    // hydrated, so a pre-hydration click cannot emit a partial POST.
    await expect(form).toHaveAttribute('data-hydrated', 'true', { timeout: 10_000 });

    // §AXIS-T — fill required fields on step 1. Type has default value
    // 'tama38_2'. V11 A.S6 turned /projects/new into a 3-step wizard
    // (Details → Structure → Review); the Create button (type="submit")
    // only renders on step 3, so we must click "הבא" twice to reach it.
    // Step 2 (Structure) is optional — we skip adding buildings so the
    // wire body stays the same back-compat shape this test expects.
    await page.locator('input#name').fill(FORM_VALUES.name);
    await page.locator('select#type').selectOption(FORM_VALUES.type);
    await page.locator('textarea#description').fill(FORM_VALUES.description);

    // Step 1 → Step 2
    await page.getByRole('button', { name: 'הבא' }).click();
    // Step 2 → Step 3 (no buildings added — empty structure stays valid)
    await page.getByRole('button', { name: 'הבא' }).click();

    // Step 3: the only `type="submit"` in the document. Click, then wait
    // on the REDIRECT as the success signal — not on a `waitForResponse`
    // race. The POST is intercepted and fulfilled by page.route(), and
    // `onSubmit` only calls router.push AFTER `mutateAsync` resolves, so
    // the navigation is causally downstream of a captured POST: once the
    // URL is the detail page, `postCount`/`capturedBody`/`idempotencyKey`
    // are guaranteed already set by the route handler. The previous
    // `Promise.all([waitForResponse, click])` form flaked under load — the
    // intercepted response fired inside the 10s window (trace-confirmed:
    // POST @54.2s, wait window 54.1→64.1s) yet the response event was
    // missed, while the redirect itself always succeeded. Asserting the
    // causal signal removes the race without weakening any §AXIS check.
    await page.locator('button[type="submit"]').click();

    // §AXIS-V/U — navigated to detail page (success signal).
    await page.waitForURL(new RegExp(`/he/projects/${NEW_PROJECT_ID}$`), { timeout: 15_000 });
    expect(page.url()).toMatch(new RegExp(`/he/projects/${NEW_PROJECT_ID}$`));

    // §AXIS-A — wire-level assertions. Guaranteed captured: the redirect
    // above only fires after the POST resolved through the route handler.
    expect(postCount, 'exactly one POST /projects').toBe(1);
    const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
    expect(body['name']).toBe(FORM_VALUES.name);
    expect(body['type']).toBe(FORM_VALUES.type);
    expect(body['description']).toBe(FORM_VALUES.description);

    // §AXIS-S — Idempotency-Key header MUST be present and shaped
    // as a UUIDv4 per api-client.ts:262-269.
    expect(idempotencyKey, 'Idempotency-Key header set by postIdempotent').not.toBeNull();
    expect(idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // §AXIS-U — URL bar must not carry any of the field values.
    expect(page.url(), 'no name in URL').not.toContain(encodeURIComponent(FORM_VALUES.name));
    expect(page.url()).not.toContain(encodeURIComponent(FORM_VALUES.description));
    expect(page.url()).not.toMatch(/[?&](name|type|description)=/);

    // §AXIS-V — detail page renders the created project's heading.
    // This implicitly waits for the GET /projects/<id> to complete
    // (the heading depends on data from useProject). Asserting
    // getDetailCount BEFORE this would race the fetch.
    await expect(page.getByRole('heading', { name: FORM_VALUES.name })).toBeVisible({
      timeout: 10_000,
    });

    // §AXIS-A — detail GET completed after redirect (heading visible
    // proves it; this is a defensive double-check that the routing
    // actually went through our handler vs. some other code path).
    expect(getDetailCount, 'detail page fetched after redirect').toBeGreaterThanOrEqual(1);

    // §AXIS-S (console) — fixture auto-asserts.
    expect(consoleErrors.count, 'no console errors during create').toBe(0);
  });

  // §FUNC-4 mechanism proof (D.51) — the hydration gate must live in the
  // PRODUCT (server markup), not in test timing. This asserts the raw
  // SSR HTML — fetched over HTTP with NO browser, NO JS execution, so it
  // is the byte-for-byte first paint a slow-connection user sees before
  // hydration. The form must be marked `data-hydrated="false"` and the
  // step-1 "next" control must be `disabled`. A test-only plaster (a
  // bumped timeout or waitForTimeout) cannot make these strings appear in
  // server output — only the product gate does. This is the criterion a
  // plaster cannot pass.
  test('2) SSR markup gates interaction until hydrated (mechanism, not timing)', async ({
    page,
    context,
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

    // Raw server response — context cookies are sent; the dashboard
    // layout's SSR getMe() resolves against the mock backend, so the
    // page renders (no redirect to /login).
    const res = await page.request.get('/he/projects/new');
    expect(res.status(), 'authenticated SSR render, not a redirect/401').toBe(200);
    const html = await res.text();

    // The wizard ships unhydrated on first paint.
    expect(html, 'form marked not-yet-hydrated in server markup').toContain(
      'data-hydrated="false"',
    );

    // The "next" control is rendered disabled until hydration. shadcn
    // Button forwards the `disabled` prop to the underlying <button>;
    // assert at least one disabled button exists in the pre-hydration
    // markup (Back is not rendered on step 1, so this is the Next button).
    expect(html, 'a nav control is disabled in pre-hydration markup').toMatch(
      /<button[^>]*\sdisabled(?:=""|\s|>)/i,
    );
  });
});
