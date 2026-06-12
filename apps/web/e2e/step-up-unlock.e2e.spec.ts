/**
 * §E-7c-F1 — PII step-up unlock modal REGRESSION net (track-d, post-merge).
 *
 * Codifies the MERGED 7c F1 behavior (apps/web/src/components/
 * step-up-unlock.tsx + the documents/[id] caller): a sensitive document's
 * download answers 403 `{ error: { code: 'pii_step_up_required' } }` → the
 * unlock dialog opens ("אימות נוסף") → POST /auth/step-up/request emails a
 * 6-digit code → the user TYPES it → POST /auth/step-up/verify { code } →
 * on 200 the ORIGINAL download is retried once and succeeds (7d sensitive
 * docs decrypt-STREAM bytes, so the retry answers application/pdf bytes).
 *
 * Regression pins (the bugs this net exists to catch):
 *  - The SUPPRESS fix (api-client SUPPRESS_EVENT + 'invalid_step_up_code'):
 *    a WRONG code is a FORM-level 401 — it shows the one generic
 *    "wrong or expired" line and must NEVER fire `emapp:unauthenticated`
 *    (no logout, no /login bounce, dialog stays up).
 *  - The retry contract: exactly TWO download GETs (403 then 200), the
 *    request/verify pair BETWEEN them, in order.
 *  - The OTP code rides POST BODIES only — never any URL (the dialog's
 *    <form method="post"> GET-fallback guard, repo DoD).
 *
 * Stub style mirrors j3b/p3c: catch-all FIRST (+ stray-write trap), specific
 * routes after (Playwright matches last-registered first), call-order
 * ledger, §P0-3 console fixture.
 *
 * 4-axis smoke:
 *   Network  — call ORDER: GET download(403) → POST request → POST verify
 *              (wrong, 401) → POST verify (ok) → GET download(200). Zero
 *              stray writes.
 *   URL      — stays on /he/documents/<id>; the code value appears in NO
 *              request URL.
 *   Cookies  — access_token rides the download GET (auth-guarded route).
 *   Redirect — NONE on the wrong-code 401 (the SUPPRESS pin) and none after
 *              success (bytes open locally; no storage host in the URL).
 */
import { test, expect } from './fixtures';

const DOC_ID = '00000000-0000-4000-8000-d0c07c000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000003';

// Digit runs that can never collide with the all-zero UUID fixtures above —
// the "no code in any URL" assertion greps every request URL for these.
const WRONG_CODE = '313131';
const GOOD_CODE = '424242';

const CREATED_AT = '2026-06-12T08:00:00.000Z';

const FILE_NAME = 'id-card.pdf';
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(120, 0x20)]);

/** SENSITIVE document meta (type id_document → server-derived sensitive). */
const DOC_ROW = {
  id: DOC_ID,
  organizationId: ORG_ID,
  projectId: null,
  apartmentId: null,
  name: FILE_NAME,
  type: 'id_document',
  mimeType: 'application/pdf',
  sizeBytes: PDF_BYTES.byteLength,
  contentHash: 'a'.repeat(64),
  uploadedBy: MANAGER_USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
};

/** GET /me — manager holding the download permission the page gates on. */
const PROFILE = {
  id: MANAGER_USER_ID,
  name: 'מנהלת',
  email: 'mgr@alpha.dev',
  role: 'manager',
  avatarColor: null,
  organization: { id: ORG_ID, name: 'Alpha', slug: 'alpha-dev' },
  view_owner_pii: true,
  permissions: ['documents.read', 'documents.download', 'documents.archive'],
};

test.describe('§E-7c-F1 — step-up unlock modal (sensitive document download)', () => {
  test('1) 403 → modal → send code → wrong code = generic error WITHOUT logout → right code → download retries and succeeds', async ({
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

    // The SUPPRESS pin needs a witness: record whether the global
    // unauthenticated event EVER fires (api-client dispatches it on
    // terminal 401s; 'invalid_step_up_code' is suppressed by design).
    await page.addInitScript(() => {
      (window as unknown as { __emappUnauthFired: boolean }).__emappUnauthFired = false;
      window.addEventListener('emapp:unauthenticated', () => {
        (window as unknown as { __emappUnauthFired: boolean }).__emappUnauthFired = true;
      });
    });

    const callOrder: string[] = [];
    const strayWrites: string[] = [];
    const requestUrls: string[] = [];
    let verified = false;
    let downloadCount = 0;
    let downloadHadCookie = false;
    let requestBody: string | null = null;
    const verifyBodies: string[] = [];

    page.on('request', (r) => requestUrls.push(r.url()));

    // Benign catch-all (notifications etc) + stray-write trap. Registered
    // FIRST — Playwright matches last-registered first, so the specific
    // routes below win.
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') {
        strayWrites.push(`${req.method()} ${new URL(req.url()).pathname}`);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.route('**/api/v1/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: PROFILE }),
      });
    });

    // GET /documents/<id> — the sensitive document's meta (detail page).
    await page.route(`**/api/v1/documents/${DOC_ID}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: DOC_ROW }),
      });
    });

    // GET /documents/<id>/download — 403 pii_step_up_required UNTIL the
    // session verifies, then the 7d sensitive byte-stream (application/pdf).
    await page.route(`**/api/v1/documents/${DOC_ID}/download*`, async (route) => {
      downloadCount += 1;
      callOrder.push('GET /documents/:id/download');
      const cookieHeader = await route.request().headerValue('cookie');
      downloadHadCookie = !!cookieHeader && cookieHeader.includes('access_token');
      if (!verified) {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'pii_step_up_required', message: 'step-up required' },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'content-disposition': `inline; filename="${FILE_NAME}"` },
        body: PDF_BYTES,
      });
    });

    // POST /auth/step-up/request — mint+email the code. The dev/QA
    // `data.code` exposure is deliberately NOT included: the FE must never
    // read it (lib/api/step-up.ts pins that posture).
    await page.route('**/api/v1/auth/step-up/request', async (route) => {
      callOrder.push('POST /auth/step-up/request');
      requestBody = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });

    // POST /auth/step-up/verify { code } — wrong code = the FORM-level 401
    // `invalid_step_up_code` (suppressed from the global event); right code
    // stamps the session unlock.
    await page.route('**/api/v1/auth/step-up/verify', async (route) => {
      callOrder.push('POST /auth/step-up/verify');
      const body = route.request().postData() ?? '';
      verifyBodies.push(body);
      const { code } = JSON.parse(body) as { code: string };
      if (code !== GOOD_CODE) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'invalid_step_up_code' } }),
        });
        return;
      }
      verified = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });

    await page.goto(`/he/documents/${DOC_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page.getByRole('heading', { name: FILE_NAME })).toBeVisible({ timeout: 15_000 });

    // Click הצג (the inline/View disposition) → the gated download 403s →
    // the F1 modal opens instead of an error line.
    await page.getByRole('button', { name: 'הצג' }).click();
    const dialog = page.getByTestId('step-up-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'אימות נוסף' })).toBeVisible();

    // Stage 1 — request the code.
    await page.getByTestId('step-up-send-code').click();
    const codeInput = page.getByTestId('step-up-code-input');
    await expect(codeInput).toBeVisible({ timeout: 10_000 });
    // The dialog's verify <form> carries method="post" (§AXIS-V — a
    // pre-hydration native submit must never put the OTP in a GET URL).
    const verifyForm = page.locator('form', { has: codeInput });
    expect((await verifyForm.getAttribute('method'))?.toLowerCase()).toBe('post');

    // Stage 2 — WRONG code: the generic remaining-attempts-agnostic line,
    // and CRUCIALLY no logout (the 7c SUPPRESS pin).
    await codeInput.fill(WRONG_CODE);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/auth/step-up/verify') && r.status() === 401,
        { timeout: 15_000 },
      ),
      page.getByTestId('step-up-verify').click(),
    ]);
    await expect(page.getByTestId('step-up-error')).toHaveText('הקוד שגוי או שפג תוקפו. נסה שוב.');
    // §SUPPRESS — no emapp:unauthenticated, no /login bounce, dialog intact.
    expect(
      await page.evaluate(
        () => (window as unknown as { __emappUnauthFired: boolean }).__emappUnauthFired,
      ),
      'a wrong step-up code must NOT fire emapp:unauthenticated (7c SUPPRESS pin)',
    ).toBe(false);
    expect(page.url()).toContain(`/he/documents/${DOC_ID}`);
    await expect(dialog).toBeVisible();
    // Wrong code clears the input for the next attempt.
    await expect(codeInput).toHaveValue('');

    // Stage 3 — RIGHT code: verify 200 → the ORIGINAL download retries and
    // succeeds (the second GET answers the decrypt-streamed bytes).
    await codeInput.fill(GOOD_CODE);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/documents/${DOC_ID}/download`) &&
          r.request().method() === 'GET' &&
          r.status() === 200,
        { timeout: 15_000 },
      ),
      page.getByTestId('step-up-verify').click(),
    ]);
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    // No failure line — the retry SUCCEEDED.
    await expect(page.getByText('ההורדה נכשלה.')).toHaveCount(0);

    // §AXIS-Network — the exact call order: gated GET → request → verify
    // (wrong) → verify (ok) → retried GET. Nothing else wrote.
    expect(callOrder).toEqual([
      'GET /documents/:id/download',
      'POST /auth/step-up/request',
      'POST /auth/step-up/verify',
      'POST /auth/step-up/verify',
      'GET /documents/:id/download',
    ]);
    expect(downloadCount, 'exactly two download GETs: 403 then the retry').toBe(2);
    expect(strayWrites, `stray writes: ${strayWrites.join(' | ')}`).toEqual([]);

    // The code rides POST bodies ONLY — never a URL (GET-fallback guard).
    expect(JSON.parse(verifyBodies[0] ?? '{}')).toEqual({ code: WRONG_CODE });
    expect(JSON.parse(verifyBodies[1] ?? '{}')).toEqual({ code: GOOD_CODE });
    expect(requestBody ?? '').not.toContain(WRONG_CODE);
    for (const url of requestUrls) {
      expect(url, `OTP code leaked into a URL: ${url}`).not.toContain(WRONG_CODE);
      expect(url, `OTP code leaked into a URL: ${url}`).not.toContain(GOOD_CODE);
    }

    // §AXIS-Cookies — the gated download rides the session cookie.
    expect(downloadHadCookie, 'download GET must carry the auth cookie').toBe(true);

    // §AXIS-U/Redirect — still on the document page; nothing leaked.
    expect(page.url()).toContain(`/he/documents/${DOC_ID}`);
    expect(page.url()).not.toContain('cloudflarestorage.com');

    // §AXIS-S (console) — Chromium logs the INTENTIONAL stubbed 403/401
    // status lines as network console.error (same carve-out pattern as
    // p3c test 2 / J1 / J10); anything else is a real bug.
    const real = consoleErrors.all.filter(
      (e) => !/\b40[13]\b/.test(e) && !/Forbidden|Unauthorized/i.test(e),
    );
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
