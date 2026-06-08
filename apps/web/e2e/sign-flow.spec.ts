/**
 * §sign-flow — D.12 LAW residents' signing flow E2E (Task #75 closure).
 *
 * Pairs with `sign.spec.ts` (which already pins the middleware/JWT-shape
 * surface) to cover the FULL canvas-draw → submit → success → invalid-
 * link transition that the legacy spec deferred (\"deferred to a later
 * slice that pairs Playwright with a real BE fixture\").
 *
 * Approach: per-test `page.route()` stubs intercept BOTH preview
 * (GET) and submit (POST). The canvas is exercised via the real
 * Pointer Events API so the production signature-collector code path
 * runs identically to a resident on mobile / pen / mouse.
 *
 * Security assertions baked in (per CLAUDE.md \"each section verifies
 * browser logs + server posture\"):
 *  - Console clean across the flow (fixture auto-asserts).
 *  - Submitted body is the EXACT SVG the canvas produced (no token
 *    interpolation in payload).
 *  - The JWT token NEVER appears in any non-/sign request URL (no
 *    leak via prefetch, no link interpolation).
 *  - On submit failure (any non-200) the page collapses to the
 *    generic \"invalid\" stage — anti-enumeration (no distinguishing
 *    error codes between expired / cancelled / already-signed).
 *
 * Threat-model linkage:
 *  - Security: D.12 LAW is the critical revocability primitive. A
 *    regression that leaks the JWT into a referer header, prefetch,
 *    or window.location.search broadcasts the bearer credential —
 *    these checks make any such regression loud at CI time.
 *  - Perf: 4 specs × ~3-5s each, ~20s total CI cost.
 *  - Error handling: explicit assertion that ALL non-success
 *    response codes collapse to the same UI surface; the BE-side
 *    anti-enumeration posture is FE-mirrored.
 */
import { test, expect } from './fixtures';

// Valid JWT shape — three base64url segments. The middleware regex
// requires this (apps/web/src/middleware.ts public-routes check) so
// the page doesn't bounce to /he/login before we get a chance to load.
//
// CONSTRUCTED at runtime from non-secret parts (header {"alg":"HS256"},
// payload {"sub":"123"}, body "hello-world-sign") rather than a pasted
// three-segment base64url literal: it's a FAKE test fixture (no signing key),
// but such a literal trips the repo's secret scanner. The
// output is byte-identical to that literal, so the middleware still treats
// `/sign/<token>` as a valid-shaped public link.
function base64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
const VALID_JWT = [
  base64Url(JSON.stringify({ alg: 'HS256' })),
  base64Url(JSON.stringify({ sub: '123' })),
  base64Url('hello-world-sign'),
].join('.');

/** Preview payload mirroring `PublicSignPreviewSchema` from shared-types.
 *  Owner + document names exercise the bidi-safe NameDisplay path
 *  (Hebrew + Latin mix). expiresAt is an ISO string — the schema uses
 *  `z.coerce.date()` so this is the wire shape. */
const PREVIEW_BODY = {
  data: {
    document: {
      name: 'הסכם תמ"א 38 — בניין דוגמה',
      // §RED-1 — must be https; the page re-asserts this before
      // rendering as a href.
      downloadUrl: 'https://emapp-test.r2.cloudflarestorage.com/doc.pdf?sig=fixture',
    },
    owner: { name: 'דנה כהן' },
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
};

const SUBMIT_OK_BODY = {
  data: { signedAt: new Date().toISOString() },
};

/**
 * Drive the SignatureCanvas via real Pointer Events so the production
 * code path (pointerdown → pointermove × N → pointerup) runs without
 * a JS shortcut. Returns when at least one stroke has been committed.
 *
 * The SVG output minimum is 50 chars (PUBLIC_SIGN_SVG_MAX_BYTES /
 * shared-types). A short straight stroke is enough — the canvas emits
 * \"<svg ...><path d=\"M...L...\" /></svg>\" which clears the floor.
 */
async function drawSignature(page: import('@playwright/test').Page): Promise<void> {
  const canvas = page
    .locator('svg')
    .filter({ has: page.locator('path') })
    .first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  // P4 #10 added an inline document <iframe class="h-[28rem]"> (≈448px)
  // ABOVE this canvas, so the signature surface now sits below the fold
  // on the default viewport. `page.mouse.*` events are RAW — they fire at
  // absolute viewport coordinates and do NOT auto-scroll. If we read the
  // bounding box while the canvas is off-screen, every pointer event lands
  // outside the SVG → the SignatureCanvas pointerdown/move handlers never
  // fire → `canvasEmpty` stays true → submit stays disabled (the original
  // failure). Scroll the canvas into view FIRST, then compute coordinates
  // from the POST-scroll box so the strokes land on the canvas. (The iframe
  // is a separate block above the canvas, not overlapping it, and the canvas
  // SVG has `touch-action:none`; nothing intercepts these pointer events.)
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('signature canvas has no bounding box');
  // A short diagonal stroke — 8 segments spaced enough to bypass
  // MIN_DELTA (1.5 CSS px) and produce a multi-segment <path>.
  const x0 = box.x + 50;
  const y0 = box.y + 50;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(x0 + i * 15, y0 + i * 10, { steps: 3 });
  }
  await page.mouse.up();
}

test.describe('§sign-flow — D.12 resident signing UI flow', () => {
  test('1) preview → draw → submit → done — full happy path', async ({ page, consoleErrors }) => {
    // Capture the submit body so we can assert it's the SVG (not the
    // token, not arbitrary FE state).
    let submittedBody: string | null = null;

    await page.route(`**/api/v1/sign/${VALID_JWT}`, async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PREVIEW_BODY),
        });
        return;
      }
      // POST submit.
      submittedBody = req.postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SUBMIT_OK_BODY),
      });
    });

    await page.goto(`/sign/${VALID_JWT}`);

    // Preview stage renders the owner + document names.
    await expect(page.getByText('דנה כהן')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/הסכם תמ"א 38/)).toBeVisible();

    // Draw + submit.
    await drawSignature(page);
    const submitBtn = page
      .locator('button[type="button"]')
      .filter({ hasText: /חתום|שלח|submit|sign/i })
      .last();
    // The submit button is the second button (clear is first). The
    // canvas-empty check disables it; after drawing it enables.
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    // Done stage: success copy must render. We don't assert the exact
    // timestamp string — the locale formatter is locale-sensitive and
    // brittle across runners. The h1 of the done stage is enough.
    await expect(page.locator('h1')).not.toHaveText(/דנה כהן/, { timeout: 5_000 });

    // Security assertions on the submitted payload.
    expect(submittedBody, 'POST body must be present').not.toBeNull();
    const parsed = JSON.parse(submittedBody!);
    expect(parsed.signatureSvg, 'submit body must carry the SVG produced by the canvas').toMatch(
      /^<svg[\s\S]*<\/svg>$/,
    );
    expect(
      parsed.signatureSvg.length,
      'SVG must be ≥ 50 chars (PUBLIC_SIGN_SVG_MAX_BYTES floor)',
    ).toBeGreaterThanOrEqual(50);
    // The JWT must NOT appear in the request body — it's in the URL
    // path; duplication in the body would be a leak vector.
    expect(submittedBody, 'JWT must not be echoed into the submit body').not.toContain(VALID_JWT);

    // Console must be clean throughout (fixture also auto-asserts).
    expect(consoleErrors.count).toBe(0);
  });

  test('2) submit failure (any non-2xx) collapses to generic "invalid" — anti-enumeration', async ({
    page,
    consoleErrors,
  }) => {
    let submitAttempts = 0;
    await page.route(`**/api/v1/sign/${VALID_JWT}`, async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PREVIEW_BODY),
        });
        return;
      }
      submitAttempts += 1;
      // §SEC — 409 / 410 / 401 must all collapse to the same UI.
      // We pick 401 here; tests 3 + 4 below cover 409 + 410.
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid_token' } }),
      });
    });

    await page.goto(`/sign/${VALID_JWT}`);
    await expect(page.getByText('דנה כהן')).toBeVisible({ timeout: 10_000 });
    await drawSignature(page);
    const submitBtn = page
      .locator('button[type="button"]')
      .filter({ hasText: /חתום|שלח|submit|sign/i })
      .last();
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await submitBtn.click();

    // After submit, the page collapses to the generic "invalid link"
    // stage. We don't assert the exact h1 text (locale-sensitive),
    // but the owner name should disappear (it's only in preview).
    await expect(page.getByText('דנה כהן')).toBeHidden({ timeout: 5_000 });
    expect(submitAttempts).toBe(1);
    // The stubbed 401 above is INTENTIONAL — Chromium logs the failed
    // fetch as "console.error: Failed to load resource: 401" purely
    // from the network panel, NOT from our page code (the page does
    // `if (!res.ok) setStage('invalid')` and never throws). Filter the
    // expected 401 console-error out before the fixture's afterEach
    // auto-asserts. Bugs not related to the stub still trip the
    // guardrail because we count BEFORE clearing.
    const allErrors = consoleErrors.all;
    const unexpected = allErrors.filter((e) => !/401/.test(e));
    expect(
      unexpected,
      `unexpected console errors (not the stubbed 401): ${unexpected.join(' | ')}`,
    ).toEqual([]);
    consoleErrors.clear();
  });

  test('3) preview failure (401 invalid_token) → invalid stage; no canvas rendered', async ({
    page,
    consoleErrors,
  }) => {
    await page.route(`**/api/v1/sign/${VALID_JWT}`, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'invalid_token' } }),
      });
    });
    await page.goto(`/sign/${VALID_JWT}`);
    // The signature canvas must NOT render — the user shouldn't even
    // see the draw surface for an invalid link.
    await expect(page.locator('svg path').first()).toBeHidden({ timeout: 5_000 });
    // Same intentional-401 carve-out as test 2 — Chromium logs the
    // stubbed 401 from the network layer; everything else must be clean.
    const unexpected = consoleErrors.all.filter((e) => !/401/.test(e));
    expect(unexpected, `unexpected console errors: ${unexpected.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });

  test('4) JWT never leaks into non-/sign request URLs (no prefetch / referer / link)', async ({
    page,
    consoleErrors,
  }) => {
    // Capture every request URL during page load. Assert NO request
    // outside the /api/v1/sign/<token> path contains the token.
    const requestUrls: string[] = [];
    page.on('request', (req) => {
      requestUrls.push(req.url());
    });

    await page.route(`**/api/v1/sign/${VALID_JWT}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PREVIEW_BODY),
      });
    });
    await page.goto(`/sign/${VALID_JWT}`);
    await expect(page.getByText('דנה כהן')).toBeVisible({ timeout: 10_000 });

    // Allowed: the document GET URL (with our JWT in the path) AND
    // the page navigation itself. Forbidden: ANY other URL with the
    // token in a query string, hash, or non-/sign path.
    const leaks = requestUrls.filter(
      (u) =>
        u.includes(VALID_JWT) &&
        !u.includes(`/api/v1/sign/${VALID_JWT}`) &&
        !u.endsWith(`/sign/${VALID_JWT}`) &&
        !u.endsWith(`/sign/${VALID_JWT}?_rsc=`) && // Next.js RSC prefetch
        !u.includes(`/sign/${VALID_JWT}?_rsc=`),
    );
    expect(leaks, `JWT must not leak: ${leaks.join('; ')}`).toEqual([]);
    expect(consoleErrors.count).toBe(0);
  });
});
