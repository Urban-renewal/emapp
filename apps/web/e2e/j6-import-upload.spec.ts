/**
 * §E-J6 — Manager Excel import (upload + start half).
 *
 * Wave 1 slice 13 — partial coverage of MATRIX-V2 §7 item #6:
 * "Manager — Import (Excel upload → SSE progress → mapping wizard →
 * completion)".
 *
 * Scope note: this slice ships the **upload + start** half (analogous
 * to J3 for documents). The SSE-consumer half (detail page receiving
 * progress frames, mapping wizard at status=awaiting_mapping) needs
 * an SSE-formatted stub body + multi-frame coordination — its own
 * slice with EventSource testing.
 *
 * 3-call flow under test (same pattern as J3, with `xlsx` instead
 * of `pdf` mime + an extra `start` POST at the tail):
 *   1. POST /imports → { import, uploadUrl }
 *   2. PUT to presigned URL (xhr — content-type xlsx)
 *   3. POST /imports/:id/start
 *
 * On success the FE router.push's to /he/imports/:id.
 *
 * D.17 cells exercised:
 *   - `imports.create` (Manager-only).
 *   - `imports.update` (the /start endpoint is `update` per
 *     imports.controller.ts:109 @AuthzAction).
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; select project + xlsx file; submit.
 *   U — URL stays on /he/imports/new during upload; lands on
 *       /he/imports/:id after start.
 *   V — `<form method="post">` SSR attribute.
 *   A — exactly 3 calls in order: POST /imports → PUT <presigned>
 *       → POST /imports/:id/start. The PUT MUST NOT carry cookies
 *       (D.28 R-CRITICAL — same posture as documents/J3).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const PROJECT_ID = '00000000-0000-4000-8000-000040040001';
const PROJECT_NAME = 'תמ"א 38 — דוגמה';
const NEW_IMPORT_ID = '00000000-0000-4000-8000-09099090a001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';

const PRESIGNED_HOST = 'https://emapp-test.r2.cloudflarestorage.com';
const UPLOAD_URL = `${PRESIGNED_HOST}/org/test/import/abc.xlsx?X-Amz-Signature=fake`;

const FILE_NAME = 'owners.xlsx';
const FILE_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Minimal "ZIP" magic-byte header (xlsx files are ZIP). BE worker
// preflight checks magic bytes — but the BE is fully stubbed here.
const FILE_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(120, 0x00)]);

test.describe('§E-J6 — Excel import (upload + start)', () => {
  test('1) Manager uploads xlsx → POST → PUT → start → /imports/<id>', async ({
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

    let postCreate = 0;
    let putUpload = 0;
    let postStart = 0;
    let putHadCookies = false;
    let putContentType: string | null = null;
    const callOrder: string[] = [];
    const now = new Date().toISOString();

    // Benign catch-all.
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // Projects list — the form needs at least 1 project to enable.
    await page.route('**/api/v1/projects?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: PROJECT_ID,
              organizationId: ORG_ID,
              name: PROJECT_NAME,
              type: 'tama38_2',
              status: 'gathering_signatures',
              description: null,
              targetSignaturePct: null,
              startedAt: null,
              createdBy: MANAGER_USER_ID,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              // ProjectListItem (Project + stats) — FE parses ProjectListItemSchema.
              buildingsCount: 0,
              unitsCount: 0,
              signaturesPendingCount: 0,
              signaturesSignedCount: 0,
              agentsCount: 0,
            },
          ],
          page: { limit: 100, cursor: null, has_more: false },
        }),
      });
    });

    // POST /imports.
    await page.route('**/api/v1/imports', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postCreate += 1;
      callOrder.push('POST /imports');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            import: {
              id: NEW_IMPORT_ID,
              organizationId: ORG_ID,
              projectId: PROJECT_ID,
              fileName: FILE_NAME,
              fileSizeBytes: FILE_BYTES.byteLength,
              fileContentHash: 'a'.repeat(64),
              status: 'queued',
              totalRows: null,
              processedRows: 0,
              okRows: 0,
              failedRows: 0,
              dryRun: false,
              requireConfirm: false,
              confirmedAt: null,
              startedAt: null,
              finishedAt: null,
              errorMessage: null,
              fileDeletedAt: null,
              parsedHeaders: null,
              mappingTemplateId: null,
              createdBy: MANAGER_USER_ID,
              createdAt: now,
              updatedAt: now,
            },
            uploadUrl: UPLOAD_URL,
            uploadExpiresInSeconds: 300,
          },
        }),
      });
    });

    // PUT to R2 presigned URL.
    await page.route(`${PRESIGNED_HOST}/**`, async (route) => {
      putUpload += 1;
      callOrder.push('PUT <presigned>');
      const req = route.request();
      const cookieHeader = await req.headerValue('cookie');
      putHadCookies = !!cookieHeader && cookieHeader.length > 0;
      putContentType = await req.headerValue('content-type');
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    });

    // POST /imports/:id/start.
    await page.route(`**/api/v1/imports/${NEW_IMPORT_ID}/start`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      postStart += 1;
      callOrder.push('POST /imports/<id>/start');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_IMPORT_ID,
            organizationId: ORG_ID,
            projectId: PROJECT_ID,
            fileName: FILE_NAME,
            fileSizeBytes: FILE_BYTES.byteLength,
            fileContentHash: 'a'.repeat(64),
            status: 'parsing',
            totalRows: null,
            processedRows: 0,
            okRows: 0,
            failedRows: 0,
            dryRun: false,
            requireConfirm: false,
            confirmedAt: null,
            startedAt: now,
            finishedAt: null,
            errorMessage: null,
            fileDeletedAt: null,
            parsedHeaders: null,
            mappingTemplateId: null,
            createdBy: MANAGER_USER_ID,
            createdAt: now,
            updatedAt: now,
          },
        }),
      });
    });

    // GET /imports/:id (detail page after redirect — return the
    // "parsing" row; we don't exercise SSE in THIS slice).
    await page.route(`**/api/v1/imports/${NEW_IMPORT_ID}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: NEW_IMPORT_ID,
            organizationId: ORG_ID,
            projectId: PROJECT_ID,
            fileName: FILE_NAME,
            fileSizeBytes: FILE_BYTES.byteLength,
            fileContentHash: 'a'.repeat(64),
            status: 'parsing',
            totalRows: null,
            processedRows: 0,
            okRows: 0,
            failedRows: 0,
            dryRun: false,
            requireConfirm: false,
            confirmedAt: null,
            startedAt: now,
            finishedAt: null,
            errorMessage: null,
            fileDeletedAt: null,
            parsedHeaders: null,
            mappingTemplateId: null,
            createdBy: MANAGER_USER_ID,
            createdAt: now,
            updatedAt: now,
          },
        }),
      });
    });

    // SSE endpoint — return an immediate `end` event so the page
    // doesn't keep the EventSource open for the test duration.
    // Multi-frame progress events are the subject of a future slice.
    await page.route(`**/api/v1/imports/${NEW_IMPORT_ID}/stream`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `event: end\ndata: {"id":"${NEW_IMPORT_ID}","status":"parsing"}\n\n`,
      });
    });

    await page.goto('/he/imports/new');

    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    expect((await form.getAttribute('method'))?.toLowerCase()).toBe('post');

    // Pick project + file.
    const projectSelect = page.locator('select#project');
    await expect(projectSelect).toBeEnabled({ timeout: 10_000 });
    await projectSelect.selectOption(PROJECT_ID);

    await page.locator('input[type="file"]').setInputFiles({
      name: FILE_NAME,
      mimeType: FILE_MIME,
      buffer: FILE_BYTES,
    });

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/imports/${NEW_IMPORT_ID}/start`) &&
          r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // §AXIS-A — three calls in order.
    expect(callOrder).toEqual(['POST /imports', 'PUT <presigned>', 'POST /imports/<id>/start']);
    expect(postCreate).toBe(1);
    expect(putUpload).toBe(1);
    expect(postStart).toBe(1);

    // §AXIS-A (D.28 R-CRITICAL) — PUT must not carry cookies.
    expect(
      putHadCookies,
      'D.28 R-CRITICAL — presigned PUT must not carry cookies (credentials: omit)',
    ).toBe(false);
    expect(putContentType ?? '').toMatch(/spreadsheetml|excel|octet-stream/i);

    // §AXIS-V/U — landed on detail page.
    await page.waitForURL(new RegExp(`/he/imports/${NEW_IMPORT_ID}$`), { timeout: 10_000 });
    expect(page.url()).toMatch(new RegExp(`/he/imports/${NEW_IMPORT_ID}$`));
    // The presigned URL MUST NOT leak.
    expect(page.url()).not.toContain('cloudflarestorage.com');
    expect(page.url()).not.toContain('X-Amz-Signature');

    // §AXIS-S — console clean (SSE end event is just one frame;
    // EventSource auto-reconnect on close might log a debug entry
    // but not console.error level).
    expect(consoleErrors.count, 'no console errors during upload').toBe(0);
  });
});
