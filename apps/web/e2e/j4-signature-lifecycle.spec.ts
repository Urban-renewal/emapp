/**
 * §E-J4 — Signature lifecycle (Manager: create → display signUrl).
 *
 * Wave 1 slice 5 — covers MATRIX-V2 §7 item #4:
 * "Manager — Signature lifecycle (create → copy link → cancel)".
 *
 * Scope note (in spec): the cancel half lives on the detail page
 * (signature-requests/[id]) and requires its own stubbing. This
 * spec pins the CREATE half — the create form contract + signUrl
 * display + non-leak guarantees on the bearer URL. Cancel can land
 * as a sibling test if/when slice 6 needs it.
 *
 * D.17 cells exercised:
 *   - `signature_requests.create` (Manager-only per policy.ts).
 *
 * D.12 LAW linkage:
 *   - The `signUrl` is a BEARER credential — it embeds the JWT in
 *     the path (/sign/<jwt>) and grants single-use signing access
 *     to whoever holds it.  The FE renders it in an <input
 *     readOnly> for copy, with `dir="ltr"` so the URL doesn't get
 *     RTL-mirrored.  This test pins:
 *       1. The full URL is rendered verbatim.
 *       2. The URL ENDS with the JWT shape (3 base64url segments).
 *       3. The "view request" CTA exists (UX flow continuation).
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; stub list/owners/POST; fill form.
 *   U — URL stays on /he/signature-requests/new throughout.
 *   V — success state shows signUrl in an <input readOnly>.
 *   A — exactly one POST /signature-requests; body shape matches
 *       CreateSignatureRequestInput (documentId + ownerId only).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const DOC_ID = '00000000-0000-4000-8000-d000d000d001';
const OWNER_ID = '00000000-0000-4000-8000-000000010001';
const REQUEST_ID = '00000000-0000-4000-8000-5e95e95e9501';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
// A syntactically valid JWT (3 base64url segments) for the public
// sign URL. Mirrors the shape sign-flow.spec.ts uses.
const SIGN_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.aGVsbG8td29ybGQtc2lnbg';
// §HttpsUrlSchema — `SignatureRequestCreateResponseSchema.signUrl`
// is parsed by `HttpsUrlSchema` which REQUIRES https://. A http://
// URL would fail the Zod parse, the mutation throws, the success
// state never renders, and the test would fail on the readonly-
// input visibility assertion.
const SIGN_URL = `https://app.emapp.io/sign/${SIGN_JWT}`;

// Minimal-but-Zod-valid Document fixture (DocumentSchema in
// shared-types). We only need one — the create form's <select>
// renders by id+name.
const MOCK_DOC = {
  id: DOC_ID,
  organizationId: ORG_ID,
  projectId: null,
  apartmentId: null,
  name: 'הסכם תמ"א 38 — בניין דוגמה',
  type: 'contract',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  contentHash: 'a'.repeat(64),
  uploadedBy: MANAGER_USER_ID,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  archivedAt: null,
} as const;

// Minimal-but-Zod-valid Owner fixture. The owners list endpoint
// returns the masked-PII shape; OwnerSchema's display fields are
// name + email (national_id + phone shown masked or absent). We
// keep the shape permissive — only id + name are read by the
// <select>; we include the masked fields to satisfy any defensive
// parsing on the FE.
const MOCK_OWNER = {
  id: OWNER_ID,
  organizationId: ORG_ID,
  name: 'דנה כהן',
  email: 'dana@example.test',
  nationalIdMasked: '•••••••99',
  phoneMasked: '•••••4567',
  notes: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  archivedAt: null,
  // OwnerListItem aggregates — the owners-list parse (OwnerListItemSchema)
  // now requires these; without them the list query throws and the
  // signature page's owner select never enables.
  apartmentCount: 1,
  pendingSignatureCount: 0,
} as const;

test.describe('§E-J4 — Signature lifecycle (create + display signUrl)', () => {
  test('1) Manager creates request → signUrl displayed verbatim, no PII in URL', async ({
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

    // §AXIS-A — catch-all benign. Specific endpoints registered
    // BELOW so they win (Playwright runs latest-registered first).
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // documents list
    await page.route('**/api/v1/documents**', async (route) => {
      // Only intercept the LIST endpoint (no id segment).
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/v1/documents') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [MOCK_DOC],
          page: { limit: 100, cursor: null, has_more: false },
        }),
      });
    });

    // owners list
    await page.route('**/api/v1/owners**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/v1/owners') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [MOCK_OWNER],
          page: { limit: 100, cursor: null, has_more: false },
        }),
      });
    });

    // POST /signature-requests — the call we OWN.
    await page.route('**/api/v1/signature-requests', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postCount += 1;
      capturedBody = route.request().postData();
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            request: {
              id: REQUEST_ID,
              organizationId: ORG_ID,
              documentId: DOC_ID,
              ownerId: OWNER_ID,
              status: 'pending',
              expiresAt: expires,
              createdBy: MANAGER_USER_ID,
              createdAt: now,
              signedAt: null,
              signedSignatureId: null,
              cancelledAt: null,
              cancelledBy: null,
            },
            signUrl: SIGN_URL,
            delivery: {
              email: { available: true, status: 'sent', to: 'da***@example.test' },
              whatsapp: { available: false, reason: 'no_phone_on_file' },
              sms: { available: false, reason: 'sms_provider_not_configured' },
            },
          },
        }),
      });
    });

    await page.goto('/he/signature-requests/new');
    await expect(page).toHaveURL(/\/he\/signature-requests\/new$/);

    // Wait for the list selectors to populate (the page disables
    // them while loading).
    const docSelect = page.locator('select#document');
    const ownerSelect = page.locator('select#owner');
    await expect(docSelect).toBeEnabled({ timeout: 10_000 });
    // The recipient dropdown is scoped to the chosen document's apartment
    // owners, so it stays DISABLED until a document is picked (a wrong
    // recipient is impossible). Picking the document enables it.
    await expect(ownerSelect).toBeDisabled();

    // §AXIS-T — pick the document → the owner select enables → pick owner, submit.
    await docSelect.selectOption(DOC_ID);
    await expect(ownerSelect).toBeEnabled({ timeout: 10_000 });
    await ownerSelect.selectOption(OWNER_ID);

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/v1/signature-requests') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // §AXIS-A — exactly one POST.
    expect(postCount, 'exactly one POST /signature-requests').toBe(1);
    // Body matches the strict input shape — ONLY documentId + ownerId.
    const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
    expect(body['documentId']).toBe(DOC_ID);
    expect(body['ownerId']).toBe(OWNER_ID);
    // No other fields slipped through (strict() on the BE).
    expect(Object.keys(body).sort()).toEqual(['documentId', 'ownerId']);

    // §AXIS-V — success state renders the signUrl verbatim in a
    // readOnly input. We assert the input's value contains the full
    // URL (including the JWT shape).
    const signInput = page.locator('input[readonly][dir="ltr"]').first();
    await expect(signInput).toBeVisible({ timeout: 5_000 });
    await expect(signInput).toHaveValue(SIGN_URL);
    // The JWT shape (3 base64url segments) MUST be the last path
    // segment — a regression that swapped to a different token
    // shape would surface here.
    expect(SIGN_URL).toMatch(/\/sign\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // §AXIS-V — the "copy" + "view request" CTAs are present.
    // t('copy') = "העתק"; t('viewRequest') = "פתח את הבקשה".
    await expect(page.getByRole('button', { name: 'העתק' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'פתח את הבקשה' })).toBeVisible();

    // §AXIS-U — URL stays on /new (the success state replaces the
    // form in-page rather than navigating, so the URL doesn't change).
    expect(page.url()).toMatch(/\/he\/signature-requests\/new$/);
    // The JWT itself MUST NOT appear in the URL bar — that would
    // be a bearer-credential leak into history + logs.
    expect(page.url()).not.toContain(SIGN_JWT);

    // §AXIS-S (console) — fixture auto-asserts.
    expect(consoleErrors.count, 'no console errors during create').toBe(0);
  });
});
