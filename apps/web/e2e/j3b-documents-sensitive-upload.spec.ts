/**
 * §E-J3b — Manager SENSITIVE document upload (7d API content path).
 *
 * Sibling of j3-documents-upload.spec.ts. 7d changed the wire contract for
 * SENSITIVE docs (id_document / financial): POST /documents answers
 * `uploadUrl: null` + `contentUploadPath: "/api/v1/documents/<id>/content"`,
 * and the browser POSTs the raw bytes to that API path as
 * `application/octet-stream` — NO presigned PUT, NO finalize (the content
 * route integrity-checks, AV-scans, envelope-encrypts and stamps uploaded
 * itself; a finalize after it would 409 `document_already_uploaded`).
 *
 * S3 redesign: the <select>+submit form is GONE — the page is the generic
 * dropzone. This spec STUBS classify (suggests `id_document`, a SENSITIVE type →
 * the band is CONFIRM with the encrypt notice, NEVER silent auto-file) + dedup
 * (no duplicate). The user picks the file → confirms → the 7d content path runs
 * UNCHANGED (sensitive bytes go through the API, never to R2).
 *
 * 4-axis smoke (DoD for interactive-UI slices):
 *   Network  — exactly TWO calls, in order: POST /documents → POST
 *              /documents/<id>/content. ZERO presigned PUTs, ZERO finalize.
 *              The content POST carries Content-Type: application/octet-stream
 *              AND the session cookie (same-origin credentials — unlike the
 *              presigned PUT's credentials:'omit', this is our own API).
 *   URL      — stays on /he/documents/new during upload; never contains a
 *              storage host / signature.
 *   Cookies  — access_token rides the content POST (route is auth-guarded).
 *   Redirect — lands on /he/documents/<id> after the content POST.
 * Plus the §P0-3 console guardrail via the shared fixture.
 */
import { test, expect } from './fixtures';

const NEW_DOC_ID = '00000000-0000-4000-8000-d0c0d0c0d002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

const FILE_NAME = 'id-card.pdf';
const FILE_MIME = 'application/pdf';
const FILE_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(120, 0x20)]);

const DOC_ROW = {
  id: NEW_DOC_ID,
  organizationId: ORG_ID,
  projectId: null,
  apartmentId: null,
  name: FILE_NAME,
  type: 'id_document',
  mimeType: FILE_MIME,
  sizeBytes: FILE_BYTES.byteLength,
  contentHash: 'a'.repeat(64),
  uploadedBy: MANAGER_USER_ID,
};

test.describe('§E-J3b — Sensitive document upload (7d content path)', () => {
  test('1) Manager uploads id_document → POST create → POST content → /documents/<id>; no PUT, no finalize', async ({
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

    let postCreateCount = 0;
    let postContentCount = 0;
    let contentHadCookie = false;
    let contentContentType: string | null = null;
    let presignedPutCount = 0;
    let postFinalizeCount = 0;
    const callOrder: string[] = [];

    // Benign catch-all (notifications etc). Registered FIRST — Playwright
    // matches last-registered first, so the specific routes below win.
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (
        path === '/api/v1/documents' ||
        path === '/api/v1/documents/classify' ||
        path === '/api/v1/documents/dedup-check' ||
        path === `/api/v1/documents/${NEW_DOC_ID}` ||
        path === `/api/v1/documents/${NEW_DOC_ID}/content` ||
        path === `/api/v1/documents/${NEW_DOC_ID}/finalize`
      ) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // S3 — DH3 classify: suggest the SENSITIVE type `id_document` at high
    // confidence. The band logic DOWNGRADES auto → CONFIRM for a sensitive type,
    // so the encrypt notice is shown and the user confirms (never silent).
    await page.route('**/api/v1/documents/classify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            suggestions: [
              {
                docType: 'id_document',
                confidence: 0.95,
                signal: 'filename',
                reason: 'filename_id',
              },
            ],
            suggestOnly: true,
          },
        }),
      });
    });

    // S3 — DH4 dedup-check: no duplicate in scope.
    await page.route('**/api/v1/documents/dedup-check', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { duplicates: [], hasDuplicate: false } }),
      });
    });

    // Any direct-to-storage PUT is a 7d REGRESSION for a sensitive doc
    // (plaintext PII bytes must never go to R2). Count it; assert zero.
    await page.route('https://*.r2.cloudflarestorage.com/**', async (route) => {
      presignedPutCount += 1;
      callOrder.push('PUT <presigned>');
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    });

    // POST /documents — the 7d SENSITIVE create: uploadUrl null + contentUploadPath.
    await page.route('**/api/v1/documents', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postCreateCount += 1;
      callOrder.push('POST /documents');
      const now = new Date().toISOString();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            document: { ...DOC_ROW, createdAt: now, updatedAt: now, archivedAt: null },
            uploadUrl: null,
            uploadExpiresInSeconds: null,
            contentUploadPath: `/api/v1/documents/${NEW_DOC_ID}/content`,
          },
        }),
      });
    });

    // POST /documents/<id>/content — the raw-bytes API upload.
    await page.route(`**/api/v1/documents/${NEW_DOC_ID}/content`, async (route) => {
      postContentCount += 1;
      callOrder.push('POST /documents/<id>/content');
      const req = route.request();
      const cookieHeader = await req.headerValue('cookie');
      contentHadCookie = !!cookieHeader && cookieHeader.includes('access_token');
      contentContentType = await req.headerValue('content-type');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { uploaded: true } }),
      });
    });

    // POST /documents/<id>/finalize — MUST NOT be called on the content leg
    // (the route stamps uploaded itself; finalize would 409).
    await page.route(`**/api/v1/documents/${NEW_DOC_ID}/finalize`, async (route) => {
      postFinalizeCount += 1;
      callOrder.push('POST /documents/<id>/finalize');
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'document_already_uploaded' } }),
      });
    });

    // GET /documents/<id> — detail page after redirect.
    await page.route(`**/api/v1/documents/${NEW_DOC_ID}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { ...DOC_ROW, createdAt: now, updatedAt: now, archivedAt: null },
        }),
      });
    });

    await page.goto('/he/documents/new');
    await expect(page).toHaveURL(/\/he\/documents\/new$/);

    // §AXIS-V — the dropzone pick affordance renders.
    const pick = page.getByTestId('document-dropzone-pick');
    await expect(pick).toBeVisible({ timeout: 10_000 });

    // Pick the file → classify suggests the SENSITIVE id_document → the encrypt
    // notice + a CONFIRM button appear (never a silent auto-file for a tabu/ID).
    await page.locator('input[type="file"]').setInputFiles({
      name: FILE_NAME,
      mimeType: FILE_MIME,
      buffer: FILE_BYTES,
    });
    await expect(page.getByTestId('document-dropzone-sensitive-notice')).toBeVisible({
      timeout: 10_000,
    });

    const confirm = page.getByTestId('document-dropzone-confirm');
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/documents/${NEW_DOC_ID}/content`) &&
          r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      confirm.click(),
    ]);

    // §AXIS-Network — exactly two calls, in order; no PUT, no finalize.
    expect(callOrder).toEqual(['POST /documents', 'POST /documents/<id>/content']);
    expect(postCreateCount).toBe(1);
    expect(postContentCount).toBe(1);
    expect(presignedPutCount, '7d — sensitive bytes must NEVER go to R2 directly').toBe(0);
    expect(postFinalizeCount, '7d — the content leg must NOT finalize (would 409)').toBe(0);

    // The bytes ride as application/octet-stream WITH the session cookie
    // (same-origin API call — opposite of the presigned PUT's omit).
    expect(contentContentType ?? '').toMatch(/application\/octet-stream/i);
    expect(contentHadCookie, 'content POST must carry the auth cookie').toBe(true);

    // §AXIS-Redirect/URL — landed on the detail page; nothing leaked.
    await page.waitForURL(new RegExp(`/he/documents/${NEW_DOC_ID}$`), { timeout: 10_000 });
    expect(page.url()).not.toContain('cloudflarestorage.com');
    expect(page.url()).not.toContain('X-Amz-Signature');

    // §AXIS-S (console) — fixture auto-asserts; explicit check for clarity.
    expect(consoleErrors.count, 'no console errors during sensitive upload').toBe(0);
  });
});
