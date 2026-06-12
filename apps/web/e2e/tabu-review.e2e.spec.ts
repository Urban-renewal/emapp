/**
 * §E-7c-F3 — נסח-טאבו review flow REGRESSION net (track-d, post-merge).
 *
 * Codifies the MERGED 7c F3 behavior (apps/web/src/app/[locale]/(dashboard)/
 * apartments/[id]/_components/tabu-review-section.tsx): on the apartment
 * page a manager picks a FINALIZED apartment-scoped נסח → "צור חילוץ"
 * (POST /apartments/:id/tabu-extractions) → "הרץ פיענוח"
 * (POST /tabu-extractions/:id/extract, rowCount) → the review table renders
 * the decrypted rows (GET /tabu-extractions/:id/rows) → inline row edit
 * (PATCH …/rows/:rowId) → "אשר וכתוב בעלויות" (POST …/confirm) → the owners
 * list refetches (['ownerships'] invalidation).
 *
 * Regression pins (the bugs this net exists to catch):
 *  - MASKED-ROUNDTRIP: a •-masked nationalId ('•••••••82', D.19/D.47
 *    role-fidelity) renders READ-ONLY and the PATCH body must NEVER contain
 *    bullets — bullets round-tripping would overwrite the real encrypted
 *    value with '•••••••NN'.
 *  - The idempotency contract: a second confirm answers 409
 *    `tabu_extraction_not_draft` and the FE shows "כבר אושר" as an INFO
 *    (not an error) with NO owners refetch.
 *  - The owners-refresh contract: a confirmed 200 → a fresh
 *    GET /apartments/:id/owners hits the wire.
 *
 * Stub style mirrors j3b/p3c: catch-all FIRST (+ stray-write trap), specific
 * routes after (Playwright matches last-registered first), call-order
 * ledger, §P0-3 console fixture.
 *
 * 4-axis smoke:
 *   Network  — call ORDER: POST create → POST extract → GET rows → PATCH
 *              row → GET rows → POST confirm; strict bodies; zero stray
 *              writes (no direct PUT /ownerships bypass).
 *   URL      — stays on /he/apartments/:id; NO PII (clear national_id /
 *              names) ever rides a URL.
 *   Cookies  — access_token rides the create POST (auth-guarded routes).
 *   Redirect — none; the flow lives on the apartment surface.
 */
import { test, expect } from './fixtures';

const APT_ID = '00000000-0000-4000-8000-00000007c301';
const BUILDING_ID = '00000000-0000-4000-8000-00000007c302';
const SOURCE_DOC_ID = '00000000-0000-4000-8000-00000007c303';
const EXT_ID = '00000000-0000-4000-8000-00000007c304';
const ROW_CLEAR_ID = '00000000-0000-4000-8000-00000007c3aa';
const ROW_MASKED_ID = '00000000-0000-4000-8000-00000007c3bb';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000003';

const CREATED_AT = '2026-06-12T08:00:00.000Z';

const CLEAR_NATIONAL_ID = '123456782';
const MASKED_NATIONAL_ID = '•••••••82';

/** ApartmentSchema wire row — the page's primary GET. */
const APARTMENT = {
  id: APT_ID,
  buildingId: BUILDING_ID,
  number: '7',
  floor: 2,
  sizeSqm: null,
  rooms: 3,
  status: 'pending',
  statusChangedAt: CREATED_AT,
  lastContactAt: null,
  notes: null,
  unitType: 'apt',
  areaSqm: null,
  entrance: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
};

/** DocumentSchema wire row — the FINALIZED apartment-scoped נסח source. */
const SOURCE_DOC = {
  id: SOURCE_DOC_ID,
  organizationId: ORG_ID,
  projectId: null,
  apartmentId: APT_ID,
  name: 'נסח-טאבו.pdf',
  type: 'other',
  mimeType: 'application/pdf',
  sizeBytes: 4096,
  contentHash: 'b'.repeat(64),
  uploadedBy: MANAGER_USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
};

/** ApartmentOwnerSchema wire rows — the list the confirm must refetch. */
const OWNERS = [
  {
    id: '00000000-0000-4000-8000-00000007c3c1',
    organizationId: ORG_ID,
    name: 'בעלים נוכחי',
    email: null,
    nationalIdMasked: '•••••••11',
    phoneMasked: null,
    notes: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    ownershipId: '00000000-0000-4000-8000-00000007c3c2',
    ownershipPct: 100,
    shareNumerator: 1,
    shareDenominator: 1,
    relationship: 'owner',
    role: null,
  },
];

/** TabuExtractionSchema wire row. */
function extractionRow(over: Record<string, unknown> = {}) {
  return {
    id: EXT_ID,
    apartmentId: APT_ID,
    sourceDocumentId: SOURCE_DOC_ID,
    status: 'draft',
    createdBy: MANAGER_USER_ID,
    createdAt: CREATED_AT,
    confirmedAt: null,
    ...over,
  };
}

/** TabuExtractionReviewRowSchema rows — one CLEAR, one MASKED (the
 *  role-fidelity variants the table must render differently). */
function initialRows() {
  return [
    {
      id: ROW_CLEAR_ID,
      name: 'ישראל ישראלי',
      nationalId: CLEAR_NATIONAL_ID,
      shareNumerator: 1,
      shareDenominator: 2,
      confidence: 0.97,
      edited: false,
      position: 1,
    },
    {
      id: ROW_MASKED_ID,
      name: 'דנה כהן',
      nationalId: MASKED_NATIONAL_ID,
      shareNumerator: 1,
      shareDenominator: 2,
      confidence: 0.85,
      edited: false,
      position: 2,
    },
  ];
}

/** GET /me — manager with the catalog permissions the page gates on
 *  (TabuReviewSection mounts only for apartments.update holders). */
const PROFILE = {
  id: MANAGER_USER_ID,
  name: 'מנהלת',
  email: 'mgr@alpha.dev',
  role: 'manager',
  avatarColor: null,
  organization: { id: ORG_ID, name: 'Alpha', slug: 'alpha-dev' },
  view_owner_pii: true,
  permissions: [
    'apartments.read',
    'apartments.update',
    'apartments.archive',
    'documents.read',
    'projects.read',
    'buildings.read',
  ],
};

interface WireLedger {
  callOrder: string[];
  strayWrites: string[];
  ownersGets: () => number;
  createBody: () => string | null;
  createIdemKey: () => string | null;
  createCookie: () => string | null;
  patchBodies: string[];
}

/**
 * Install the full stub surface for the apartment page + the F3 endpoints.
 * Registered catch-all FIRST — Playwright matches last-registered first, so
 * the specific routes below win.
 */
async function installStubs(
  page: import('@playwright/test').Page,
  opts: { startWithDraft?: boolean; confirmStatus?: number } = {},
): Promise<WireLedger> {
  const callOrder: string[] = [];
  const strayWrites: string[] = [];
  let ownersGets = 0;
  let createBody: string | null = null;
  let createIdemKey: string | null = null;
  let createCookie: string | null = null;
  const patchBodies: string[] = [];

  let draftExists = opts.startWithDraft ?? false;
  // Stateful review rows — the PATCH applies, the next GET serves the edit.
  let rows = initialRows();

  // Benign catch-all (notifications, …) + stray-write trap. A direct
  // PUT /apartments/:id/ownerships here would be an F3 REGRESSION
  // (bypassing the audited confirm commit).
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

  await page.route(`**/api/v1/apartments/${APT_ID}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: APARTMENT }),
    });
  });

  // The owners LIST — the query the confirm must invalidate+refetch.
  await page.route(`**/api/v1/apartments/${APT_ID}/owners*`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    ownersGets += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: OWNERS, page: { limit: 50, cursor: null, has_more: false } }),
    });
  });

  // The apartment's documents — the נסח picker source.
  await page.route('**/api/v1/documents*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [SOURCE_DOC],
        page: { limit: 50, cursor: null, has_more: false },
      }),
    });
  });

  // GET (lifecycle list) + POST (create draft) of the apartment's extractions.
  await page.route(`**/api/v1/apartments/${APT_ID}/tabu-extractions*`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      callOrder.push('POST /tabu-extractions');
      createBody = req.postData();
      createIdemKey = await req.headerValue('idempotency-key');
      createCookie = await req.headerValue('cookie');
      draftExists = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: extractionRow() }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: draftExists ? [extractionRow()] : [],
        page: { limit: 25, cursor: null, has_more: false },
      }),
    });
  });

  // POST extract — the stub engine run (zero egress; answers rowCount).
  await page.route(`**/api/v1/tabu-extractions/${EXT_ID}/extract`, async (route) => {
    callOrder.push('POST /extract');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { rowCount: rows.length, engineId: 'stub-engine' } }),
    });
  });

  // GET rows — the DECRYPTED review rows (clear + masked variants).
  await page.route(`**/api/v1/tabu-extractions/${EXT_ID}/rows`, async (route) => {
    callOrder.push('GET /rows');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: rows }),
    });
  });

  // PATCH one row — applies the edit so the reload shows it (edited=true).
  await page.route(`**/api/v1/tabu-extractions/${EXT_ID}/rows/*`, async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    callOrder.push('PATCH /rows/:rowId');
    const body = req.postData() ?? '{}';
    patchBodies.push(body);
    const rowId = new URL(req.url()).pathname.split('/').pop();
    const patch = JSON.parse(body) as Record<string, unknown>;
    rows = rows.map((r) => (r.id === rowId ? { ...r, ...patch, edited: true } : r));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { updated: true } }),
    });
  });

  // POST confirm — the audit-first atomic commit (or the 409 idempotency
  // answer when opts.confirmStatus pins it).
  await page.route(`**/api/v1/tabu-extractions/${EXT_ID}/confirm`, async (route) => {
    callOrder.push('POST /confirm');
    if (opts.confirmStatus && opts.confirmStatus >= 400) {
      await route.fulfill({
        status: opts.confirmStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'tabu_extraction_not_draft' } }),
      });
      return;
    }
    draftExists = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: extractionRow({ status: 'confirmed', confirmedAt: '2026-06-12T09:00:00.000Z' }),
      }),
    });
  });

  return {
    callOrder,
    strayWrites,
    ownersGets: () => ownersGets,
    createBody: () => createBody,
    createIdemKey: () => createIdemKey,
    createCookie: () => createCookie,
    patchBodies,
  };
}

async function seedManager(context: import('@playwright/test').BrowserContext) {
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
}

async function openApartmentPage(page: import('@playwright/test').Page) {
  await page.goto(`/he/apartments/${APT_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  // 7c F2 — formatApartmentLabel dedup: the h1 is "דירה 7".
  await expect(page.getByRole('heading', { name: 'דירה 7' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tabu-review-section')).toBeVisible({ timeout: 10_000 });
}

test.describe('§E-7c-F3 — tabu review flow (extract → review → confirm)', () => {
  test('1) create → extract → 2 rows render (masked READ-ONLY) → name edit PATCH carries NO bullets → confirm → owners refetch', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedManager(context);
    const wire = await installStubs(page);

    await openApartmentPage(page);

    // Step 1 — pick the FINALIZED נסח and create the draft extraction.
    await page.getByTestId('tabu-source-doc-select').selectOption(SOURCE_DOC_ID);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/apartments/${APT_ID}/tabu-extractions`) &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByTestId('tabu-create-extraction').click(),
    ]);

    // §AXIS-A — strict create body (CreateTabuExtractionInput) + the
    // Idempotency-Key (create POST, Doc 06 §5.7) + the session cookie.
    expect(JSON.parse(wire.createBody() ?? '{}')).toEqual({ documentId: SOURCE_DOC_ID });
    expect(wire.createIdemKey(), 'create POST must carry an Idempotency-Key').toBeTruthy();
    expect(wire.createCookie() ?? '').toContain('access_token');

    // Step 2 — run the parse; the rowCount notice + the auto-loaded table.
    // success signal: the show-rows affordance unlocks; the table renders after
    // clicking it (the rows fetch is behind the OTP gate — stubbed 200 here).
    await page.getByTestId('tabu-show-rows').click();
    await expect(page.getByTestId('tabu-review-table')).toBeVisible({ timeout: 10_000 });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/tabu-extractions/${EXT_ID}/rows`) &&
          r.request().method() === 'GET',
        { timeout: 15_000 },
      ),
      page.getByTestId('tabu-run-extract').click(),
    ]);

    // Step 3 — the review table renders BOTH fidelity variants.
    const table = page.getByTestId('tabu-review-table');
    await expect(table).toBeVisible({ timeout: 10_000 });
    await expect(table.getByText(CLEAR_NATIONAL_ID)).toBeVisible();
    await expect(table.getByText(MASKED_NATIONAL_ID)).toBeVisible();

    // Step 4 — edit the MASKED row. The ת.ז. field is READ-ONLY (the
    // masked-roundtrip pin): bullets must never be editable, let alone sent.
    await page.getByTestId('tabu-edit-row').nth(1).click();
    const maskedIdInput = page.getByTestId('tabu-edit-national-id');
    await expect(maskedIdInput).toHaveValue(MASKED_NATIONAL_ID);
    await expect(maskedIdInput).toBeDisabled();
    expect(await maskedIdInput.getAttribute('readonly')).not.toBeNull();

    await page.getByTestId('tabu-edit-name').fill('דנה לוי');
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/tabu-extractions/${EXT_ID}/rows/`) &&
          r.request().method() === 'PATCH',
        { timeout: 15_000 },
      ),
      page.getByTestId('tabu-save-row').click(),
    ]);

    // The PATCH body is the NAME ONLY — never bullets, never a nationalId
    // key for a masked actor (UpdateTabuExtractionRowInput is .strict()).
    expect(wire.patchBodies).toHaveLength(1);
    const patchBody = wire.patchBodies[0] ?? '';
    expect(JSON.parse(patchBody)).toEqual({ name: 'דנה לוי' });
    expect(patchBody, 'masked bullets must NEVER round-trip into a PATCH').not.toContain('•');

    // The reload (GET rows #2) serves the edit back.
    await expect(table.getByText('דנה לוי')).toBeVisible({ timeout: 10_000 });

    // Step 5 — the summary line states the commit ("…— 2 בעלים…"), then
    // confirm. The owners list MUST refetch after the 200.
    const summary = page.getByTestId('tabu-confirm-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('2');
    const ownersGetsBefore = wire.ownersGets();

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/tabu-extractions/${EXT_ID}/confirm`) &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByTestId('tabu-confirm').click(),
    ]);
    await expect(page.getByTestId('tabu-notice-ok')).toHaveText('הבעלויות נכתבו בהצלחה.');

    // The ['ownerships'] invalidation refetched the owners list.
    await expect
      .poll(() => wire.ownersGets(), {
        message: 'confirm must trigger an owners refetch',
        timeout: 10_000,
      })
      .toBeGreaterThan(ownersGetsBefore);

    // §AXIS-Network — the exact call ORDER + zero stray writes (no direct
    // PUT /ownerships bypassing the audited confirm).
    expect(wire.callOrder).toEqual([
      'POST /tabu-extractions',
      'GET /rows',
      'POST /extract',
      'GET /rows',
      'PATCH /rows/:rowId',
      'GET /rows',
      'POST /confirm',
    ]);
    expect(wire.strayWrites, `stray writes: ${wire.strayWrites.join(' | ')}`).toEqual([]);

    // §AXIS-U/Redirect — still on the apartment page; NO PII in any URL.
    expect(page.url()).toContain(`/he/apartments/${APT_ID}`);
    expect(page.url()).not.toContain(CLEAR_NATIONAL_ID);

    // §AXIS-S (console) — everything answered 2xx; zero console errors.
    expect(consoleErrors.count, 'no console errors during the tabu walk').toBe(0);
  });

  test('2) second confirm 409 tabu_extraction_not_draft → "כבר אושר" INFO, NO owners refetch', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedManager(context);
    const wire = await installStubs(page, { startWithDraft: true, confirmStatus: 409 });

    await openApartmentPage(page);

    // A draft already exists → open the review rows directly.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/tabu-extractions/${EXT_ID}/rows`) &&
          r.request().method() === 'GET',
        { timeout: 15_000 },
      ),
      page.getByTestId('tabu-show-rows').click(),
    ]);
    await expect(page.getByTestId('tabu-review-table')).toBeVisible({ timeout: 10_000 });

    const ownersGetsBefore = wire.ownersGets();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/tabu-extractions/${EXT_ID}/confirm`) &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByTestId('tabu-confirm').click(),
    ]);

    // The idempotency contract — an INFO ("כבר אושר"), not an error.
    await expect(page.getByTestId('tabu-notice-info')).toHaveText('כבר אושר', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('tabu-notice-error')).toHaveCount(0);

    // Fail-closed: NO owners refetch on a failed confirm.
    expect(wire.ownersGets()).toBe(ownersGetsBefore);
    expect(wire.callOrder).toEqual(['GET /rows', 'POST /confirm']);
    expect(wire.strayWrites, `stray writes: ${wire.strayWrites.join(' | ')}`).toEqual([]);
    expect(page.url()).toContain(`/he/apartments/${APT_ID}`);

    // Chromium logs the stubbed 409 status line as a network console.error —
    // carve that one out (same pattern as p3c test 2 / J1 / J10).
    const real = consoleErrors.all.filter((e) => !/\b409\b/.test(e) && !/Conflict/i.test(e));
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
