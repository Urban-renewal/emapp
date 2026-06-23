/**
 * §E-J3 — Manager Documents upload (presigned PUT flow).
 *
 * Wave 1 slice 9 — covers MATRIX-V2 §7 item #3:
 * "Manager — Documents (upload via presigned PUT → list → download)".
 *
 * Scope note: pins the UPLOAD path (D.28 presigned-URL confidentiality
 * model). Download is a separate flow (GET /documents/:id/download)
 * that mints a short-lived presigned GET; can land as a sibling test.
 *
 * D.28 contract under test:
 *   1. POST /documents declares metadata; server-side mints the R2
 *      key + a 5-min presigned PUT URL. **`r2Key` is NEVER on the
 *      wire** — D.28 R0.
 *   2. Browser PUTs the file directly to the presigned URL with
 *      `credentials: 'omit'` (D.28 R-CRITICAL — never send cookies
 *      or Authorization to R2).
 *   3. Browser POSTs /documents/:id/finalize with `sizeBytes` +
 *      `contentHash` — the server re-checks against R2 metadata.
 *
 * S3 redesign: the flat 19-option <select>+submit form is GONE. The page is now
 * the generic scope-aware DROPZONE — pick a file → it classifies (DH3) + dedups
 * (DH4) → confidence-band UI → upload. This spec STUBS classify (CONFIRM band:
 * suggests `contract` at 0.7 → the user clicks "confirm") + dedup (no duplicate),
 * then the SAME presigned create→PUT→finalize path runs UNCHANGED.
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; set a small file via setInputFiles; confirm
 *       the suggested type.
 *   U — URL stays on /he/documents/new during upload; redirects to
 *       /he/documents/<id> after.
 *   V — the dropzone pick affordance renders; success lands on the detail page.
 *   A — three sequential calls in order:
 *         POST /documents → PUT <presigned> → POST /documents/:id/finalize.
 *       PUT carries the file body and Content-Type; PUT MUST NOT
 *       carry cookies (D.28 R-CRITICAL — `credentials: 'omit'`).
 *   S — no console errors; the presigned URL never leaks into the
 *       address bar.
 *
 * D.17 cells exercised:
 *   - `documents.create` (Manager-only).
 */
import { test, expect } from './fixtures';

const NEW_DOC_ID = '00000000-0000-4000-8000-d0c0d0c0d001';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

const PRESIGNED_HOST = 'https://emapp-test.r2.cloudflarestorage.com';
const PRESIGNED_PATH = '/org/test/doc/abc.pdf?X-Amz-Signature=fake&X-Amz-Expires=300';
const UPLOAD_URL = `${PRESIGNED_HOST}${PRESIGNED_PATH}`;

const FILE_NAME = 'contract.pdf';
const FILE_MIME = 'application/pdf';
// Minimal PDF magic-bytes + filler to clear a few-bytes ceiling. The
// FE only uses .size, .name, .type — content doesn't need to be a
// real PDF.
const FILE_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(120, 0x20)]);

test.describe('§E-J3 — Documents upload (presigned PUT)', () => {
  test('1) Manager uploads PDF → POST → PUT → finalize → /documents/<id>', async ({
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
    let putUploadCount = 0;
    let putUploadHadCookies = false;
    let putContentType: string | null = null;
    let postFinalizeCount = 0;
    const callOrder: string[] = [];

    // Benign catch-all (notifications etc).
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (
        path === '/api/v1/documents' ||
        path === '/api/v1/documents/classify' ||
        path === '/api/v1/documents/dedup-check' ||
        path === `/api/v1/documents/${NEW_DOC_ID}` ||
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

    // S3 — DH3 classify (suggest-only): CONFIRM band → suggest `contract` at 0.7
    // so the user is shown a single suggestion to confirm.
    await page.route('**/api/v1/documents/classify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            suggestions: [
              {
                docType: 'contract',
                confidence: 0.7,
                signal: 'filename',
                reason: 'filename_contract',
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

    // POST /documents — mint a presigned URL.
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
            document: {
              id: NEW_DOC_ID,
              organizationId: ORG_ID,
              projectId: null,
              apartmentId: null,
              name: FILE_NAME,
              type: 'contract',
              mimeType: FILE_MIME,
              sizeBytes: FILE_BYTES.byteLength,
              contentHash: 'a'.repeat(64),
              uploadedBy: MANAGER_USER_ID,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
            },
            uploadUrl: UPLOAD_URL,
            uploadExpiresInSeconds: 300,
          },
        }),
      });
    });

    // PUT <presigned> — R2 upload. Verify the request DOES NOT carry
    // cookies (D.28 R-CRITICAL — `credentials: 'omit'`).
    await page.route(`${PRESIGNED_HOST}/**`, async (route) => {
      putUploadCount += 1;
      callOrder.push('PUT <presigned>');
      const req = route.request();
      const cookieHeader = await req.headerValue('cookie');
      putUploadHadCookies = !!cookieHeader && cookieHeader.length > 0;
      putContentType = await req.headerValue('content-type');
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: '',
      });
    });

    // POST /documents/<id>/finalize — confirm the upload.
    await page.route(`**/api/v1/documents/${NEW_DOC_ID}/finalize`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postFinalizeCount += 1;
      callOrder.push('POST /documents/<id>/finalize');
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_DOC_ID,
            organizationId: ORG_ID,
            projectId: null,
            apartmentId: null,
            name: FILE_NAME,
            type: 'contract',
            mimeType: FILE_MIME,
            sizeBytes: FILE_BYTES.byteLength,
            contentHash: 'a'.repeat(64),
            uploadedBy: MANAGER_USER_ID,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
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
          data: {
            id: NEW_DOC_ID,
            organizationId: ORG_ID,
            projectId: null,
            apartmentId: null,
            name: FILE_NAME,
            type: 'contract',
            mimeType: FILE_MIME,
            sizeBytes: FILE_BYTES.byteLength,
            contentHash: 'a'.repeat(64),
            uploadedBy: MANAGER_USER_ID,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        }),
      });
    });

    await page.goto('/he/documents/new');
    await expect(page).toHaveURL(/\/he\/documents\/new$/);

    // §AXIS-V — the dropzone pick affordance renders.
    const pick = page.getByTestId('document-dropzone-pick');
    await expect(pick).toBeVisible({ timeout: 10_000 });

    // §AXIS-T — set the file via Playwright's setInputFiles (drives the native
    // <input type="file"> change event, which the dropzone's onPick consumes →
    // classify + dedup → the CONFIRM-band decision panel).
    await page.locator('input[type="file"]').setInputFiles({
      name: FILE_NAME,
      mimeType: FILE_MIME,
      buffer: FILE_BYTES,
    });

    // Confirm the suggested type. The flow involves THREE network round-trips;
    // wait for the final one (finalize) before asserting.
    const confirm = page.getByTestId('document-dropzone-confirm');
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/documents/${NEW_DOC_ID}/finalize`) &&
          r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      confirm.click(),
    ]);

    // §AXIS-A — three calls, in order.
    expect(callOrder).toEqual([
      'POST /documents',
      'PUT <presigned>',
      'POST /documents/<id>/finalize',
    ]);
    expect(postCreateCount).toBe(1);
    expect(putUploadCount).toBe(1);
    expect(postFinalizeCount).toBe(1);

    // §AXIS-A (D.28 R-CRITICAL) — the PUT to R2 MUST NOT carry
    // cookies. `credentials: 'omit'` is the only safe default; a
    // regression that sent the access_token to R2 would (a) likely
    // corrupt the presigned signature, and (b) leak a bearer to
    // R2's storage logs.
    expect(
      putUploadHadCookies,
      'D.28 R-CRITICAL — PUT to R2 must not carry cookies (credentials: omit)',
    ).toBe(false);
    // Content-Type on the PUT matches the canonicalized mime.
    expect(putContentType ?? '').toMatch(/application\/pdf/i);

    // §AXIS-V/U — landed on detail page.
    await page.waitForURL(new RegExp(`/he/documents/${NEW_DOC_ID}$`), { timeout: 10_000 });
    expect(page.url()).toMatch(new RegExp(`/he/documents/${NEW_DOC_ID}$`));
    // The presigned URL MUST NOT leak into the address bar.
    expect(page.url()).not.toContain('cloudflarestorage.com');
    expect(page.url()).not.toContain('X-Amz-Signature');

    // §AXIS-S (console) — fixture auto-asserts.
    expect(consoleErrors.count, 'no console errors during upload').toBe(0);
  });
});
