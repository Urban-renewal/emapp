/**
 * §E-P3c — "הקמה מגוש-חלקה" — parcel-setup preview/confirm screen (P3c FE).
 *
 * INDEPENDENT acceptance test, authored from the SPEC before the builder
 * (docs/DESIGN-phase3-parcel-autosetup.md §3 flow + §6 P3c + §7.1-2
 * "ask, no silent heuristic"). Stub style mirrors
 * j3b-documents-sensitive-upload.spec.ts (page.route, call-order ledger).
 *
 * BUILDER CONTRACT pinned here (UI affordances on the project page,
 * dashboard tab — near the existing dashboard actions):
 *  - An action named "הקמה מגוש-חלקה" (button or link).
 *  - A form with inputs #blockNumber (גוש) / #parcelNumber (חלקה) /
 *    #subParcel (תת-חלקה, optional); `<form method="post">` (GET-fallback
 *    credential-leak guard — repo DoD).
 *  - Submit → POST /api/v1/projects/:id/parcel-setups with the STRICT
 *    CreateParcelSetupInput body { blockNumber, parcelNumber, subParcel? }
 *    and an Idempotency-Key header (create POST — Doc 06 §5.7).
 *  - Provider outcome line: 'זוהה: {providerCity}' when providerStatus
 *    'found'; 'לא נמצא — המשך בהזנה ידנית' when 'not_found'.
 *  - The BUILDER rows — row 0 inputs: #b0-address, #b0-city (PRE-FILLED from
 *    providerCity when found), #b0-floorsCount (optional), generator inputs
 *    #b0-gen-floors / #b0-gen-perFloor. Apartments come from the generator
 *    OR are added individually — the USER decides; with NO decision the
 *    confirm button is DISABLED (§7.1-2 — no silent default).
 *  - Summary line (parcelSummary seam, apps/web/src/lib/parcel-payload.ts):
 *    'ייווצרו {B} בניינים ו-{A} דירות'.
 *  - Confirm button "אישור והקמה" → PATCH /api/v1/parcel-setups/:id
 *    { payload } (the strict client-built shape) THEN
 *    POST /api/v1/parcel-setups/:id/confirm — in that order, exactly once
 *    each.
 *  - After a confirmed 200 → the project buildings query is invalidated AND
 *    refetched: a fresh GET /api/v1/projects/:id/buildings must hit the wire
 *    (mount the list or refetch the active query — either satisfies).
 *  - 409 parcel_skeleton_conflict on confirm → the copy
 *    'חלק מהבניינים/הדירות כבר קיימים בפרויקט' is shown; NO buildings refetch.
 *  - 409 parcel_setup_not_draft on PATCH → the copy 'כבר אושר' is shown and
 *    confirm is NEVER POSTed (fail-closed ordering).
 *
 * 4-axis smoke (DoD for interactive-UI slices):
 *   Network  — call ORDER on the wire: POST parcel-setups → PATCH
 *              parcel-setups/:id → POST confirm; strict body shapes; zero
 *              stray writes (no direct POST /buildings bypass).
 *   URL      — stays under /he/projects/:id; the block/parcel values never
 *              ride a query string (no GET fallback).
 *   Cookies  — access_token rides the create POST (auth-guarded routes).
 *   Redirect — none required; staying on the project surface.
 * Plus the §P0-3 console guardrail via the shared fixture.
 *
 * RED today: the affordance does not exist → the "הקמה מגוש-חלקה" locator
 * times out. GREEN once the builder ships the P3c screen.
 */
import { test, expect } from './fixtures';

const PROJECT_ID = '00000000-0000-4000-8000-00000003c001';
const SETUP_ID = '00000000-0000-4000-8000-aaaabbbbcc01';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000003';

const CREATED_AT = '2026-06-12T08:00:00.000Z';

/** ProjectListItem fixture — GET /projects/:id parses ProjectListItemSchema. */
const PROJECT = {
  id: PROJECT_ID,
  organizationId: ORG_ID,
  name: 'מתחם הרצל',
  type: 'pinui_binui',
  status: 'planning',
  description: null,
  targetSignaturePct: 66,
  signatureMilestones: null,
  startedAt: null,
  createdBy: MANAGER_USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
  buildingsCount: 0,
  unitsCount: 0,
  signaturesPendingCount: 0,
  signaturesSignedCount: 0,
  agentsCount: 0,
};

const SIGNATURE_PROGRESS = {
  totalApartments: 0,
  apartmentsConsented: 0,
  signaturesSigned: 0,
  signaturesPending: 0,
  targetSignaturePct: 66,
  consentedPct: 0,
  metThreshold: false,
  // E2 Wave-1 B0 — share-weighted consent basis (required by the wire
  // SignatureProgressSchema parse).
  basis: 'share' as const,
};

/** GET /me — manager with the catalog permissions the page gates on. */
const PROFILE = {
  id: MANAGER_USER_ID,
  name: 'מנהלת',
  email: 'mgr@alpha.dev',
  role: 'manager',
  avatarColor: null,
  organization: { id: ORG_ID, name: 'Alpha', slug: 'alpha-dev' },
  view_owner_pii: true,
  permissions: [
    'projects.read',
    'projects.archive',
    'buildings.read',
    'buildings.create',
    'buildings.update',
    'apartments.read',
    'export.run',
    'documents.read',
    'documents.create',
    'signature_requests.send',
  ],
};

/** Draft envelope the create POST answers (ParcelSetupSchema wire shape). */
function setupRow(over: Record<string, unknown> = {}) {
  return {
    id: SETUP_ID,
    projectId: PROJECT_ID,
    blockNumber: '6638',
    parcelNumber: '72',
    subParcel: '4',
    status: 'draft',
    source: 'local-mapi',
    providerStatus: 'found',
    providerCity: 'תל אביב',
    payload: null,
    createdBy: MANAGER_USER_ID,
    createdAt: CREATED_AT,
    confirmedAt: null,
    ...over,
  };
}

interface WireLedger {
  callOrder: string[];
  strayWrites: string[];
  buildingsListGets: () => number;
  createBody: () => string | null;
  createIdemKey: () => string | null;
  createCookie: () => string | null;
  patchBody: () => string | null;
}

/**
 * Install the full stub surface for the project page + the P3c endpoints.
 * Registered catch-all FIRST — Playwright matches last-registered first, so
 * the specific routes below win.
 */
async function installStubs(
  page: import('@playwright/test').Page,
  opts: {
    providerStatus?: 'found' | 'not_found';
    patchStatus?: number;
    patchErrorCode?: string;
    confirmStatus?: number;
    confirmErrorCode?: string;
  } = {},
): Promise<WireLedger> {
  const callOrder: string[] = [];
  const strayWrites: string[] = [];
  let buildingsListGets = 0;
  let createBody: string | null = null;
  let createIdemKey: string | null = null;
  let createCookie: string | null = null;
  let patchBody: string | null = null;

  const providerStatus = opts.providerStatus ?? 'found';
  const providerCity = providerStatus === 'found' ? 'תל אביב' : null;

  // Benign catch-all (notifications, documents lists, …) + stray-write trap.
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

  await page.route(`**/api/v1/projects/${PROJECT_ID}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: PROJECT }),
    });
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/signature-progress`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: SIGNATURE_PROGRESS }),
    });
  });

  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/signature-progress/apartments`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    },
  );

  // The buildings LIST — the query the confirm must invalidate+refetch.
  // (`*` suffix covers ?limit=… — a `*` never crosses `/`.)
  await page.route(`**/api/v1/projects/${PROJECT_ID}/buildings*`, async (route) => {
    if (route.request().method() !== 'GET') {
      // A direct POST /buildings here would be a P3c REGRESSION (bypassing
      // the parcel-setups confirm). Falls to the catch-all stray-write trap.
      await route.fallback();
      return;
    }
    buildingsListGets += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
    });
  });

  // POST (create) + GET (list) of the project's parcel-setups.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/parcel-setups*`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      callOrder.push('POST /parcel-setups');
      createBody = req.postData();
      createIdemKey = await req.headerValue('idempotency-key');
      createCookie = await req.headerValue('cookie');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: setupRow({ providerStatus, providerCity }) }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
    });
  });

  // PATCH (save draft payload) + GET of the single setup.
  await page.route(`**/api/v1/parcel-setups/${SETUP_ID}`, async (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      callOrder.push('PATCH /parcel-setups/:id');
      patchBody = req.postData();
      if (opts.patchStatus && opts.patchStatus >= 400) {
        await route.fulfill({
          status: opts.patchStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: opts.patchErrorCode ?? 'conflict' } }),
        });
        return;
      }
      const parsed = JSON.parse(patchBody ?? '{}') as { payload?: unknown };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: setupRow({ providerStatus, providerCity, payload: parsed.payload ?? null }),
        }),
      });
      return;
    }
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: setupRow({ providerStatus, providerCity }) }),
      });
      return;
    }
    await route.fallback();
  });

  // POST confirm — the atomic skeleton materialization.
  await page.route(`**/api/v1/parcel-setups/${SETUP_ID}/confirm`, async (route) => {
    callOrder.push('POST /parcel-setups/:id/confirm');
    if (opts.confirmStatus && opts.confirmStatus >= 400) {
      await route.fulfill({
        status: opts.confirmStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: opts.confirmErrorCode ?? 'conflict' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: setupRow({
          providerStatus,
          providerCity,
          status: 'confirmed',
          confirmedAt: '2026-06-12T09:00:00.000Z',
        }),
      }),
    });
  });

  return {
    callOrder,
    strayWrites,
    buildingsListGets: () => buildingsListGets,
    createBody: () => createBody,
    createIdemKey: () => createIdemKey,
    createCookie: () => createCookie,
    patchBody: () => patchBody,
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

/** Open /he/projects/:id, switch to the dashboard tab, open the affordance. */
async function openParcelSetup(page: import('@playwright/test').Page) {
  await page.goto(`/he/projects/${PROJECT_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: 'מתחם הרצל' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('tab', { name: 'לוח בקרה' }).click();

  const action = page
    .getByRole('button', { name: 'הקמה מגוש-חלקה' })
    .or(page.getByRole('link', { name: 'הקמה מגוש-חלקה' }));
  await expect(action.first()).toBeVisible({ timeout: 10_000 });
  await action.first().click();
}

/** Fill the גוש/חלקה form and submit; resolves after the create POST lands. */
async function submitParcelForm(page: import('@playwright/test').Page) {
  const parcelForm = page.locator('form', { has: page.locator('#blockNumber') });
  await expect(parcelForm).toBeVisible({ timeout: 10_000 });
  // §AXIS-V — SSR method="post" (GET-fallback credential-leak guard, repo DoD).
  expect((await parcelForm.getAttribute('method'))?.toLowerCase()).toBe('post');

  await page.locator('#blockNumber').fill('6638');
  await page.locator('#parcelNumber').fill('72');
  await page.locator('#subParcel').fill('4');

  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/projects/${PROJECT_ID}/parcel-setups`) &&
        r.request().method() === 'POST',
      { timeout: 15_000 },
    ),
    parcelForm.locator('button[type="submit"]').click(),
  ]);
}

test.describe('§E-P3c — הקמה מגוש-חלקה (parcel-setup preview/confirm)', () => {
  test('1) found: POST → builder (city pre-filled) → generator 1×3 → summary → PATCH strict payload → confirm → buildings refetch', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedManager(context);
    const wire = await installStubs(page);

    await openParcelSetup(page);
    await submitParcelForm(page);

    // §AXIS-A — strict create body: EXACTLY the CreateParcelSetupInput keys.
    const createBody = JSON.parse(wire.createBody() ?? '{}') as Record<string, unknown>;
    expect(createBody).toEqual({ blockNumber: '6638', parcelNumber: '72', subParcel: '4' });
    expect(Object.keys(createBody).sort()).toEqual(['blockNumber', 'parcelNumber', 'subParcel']);
    // Create POST mints an Idempotency-Key (Doc 06 §5.7) + carries the cookie.
    expect(wire.createIdemKey(), 'create POST must carry an Idempotency-Key').toBeTruthy();
    expect(wire.createCookie() ?? '').toContain('access_token');

    // Provider outcome — found.
    await expect(page.getByText('זוהה: תל אביב')).toBeVisible({ timeout: 10_000 });

    // BUILDER — row 0; city PRE-FILLED from providerCity.
    await expect(page.locator('#b0-address')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#b0-city')).toHaveValue('תל אביב');
    await page.locator('#b0-address').fill('הרצל 10');

    // §7.1-2 — NO decision yet (generator empty, no explicit apartments):
    // confirm must be DISABLED. No silent default may stand in for the user.
    const confirmBtn = page.getByRole('button', { name: 'אישור והקמה' });
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toBeDisabled();

    // The user decides: קומות × דירות-לקומה = 1 × 3.
    await page.locator('#b0-gen-floors').fill('1');
    await page.locator('#b0-gen-perFloor').fill('3');

    // Summary line — the EXACT parcelSummary phrasing (seam spec SUM2).
    await expect(page.getByText('ייווצרו 1 בניינים ו-3 דירות')).toBeVisible();

    // Nothing committed yet — drafting is local until the user confirms.
    expect(wire.callOrder).toEqual(['POST /parcel-setups']);

    const buildingsGetsBefore = wire.buildingsListGets();

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/parcel-setups/${SETUP_ID}/confirm`) &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      confirmBtn.click(),
    ]);

    // §AXIS-Network — the exact call ORDER: create → save payload → confirm.
    expect(wire.callOrder).toEqual([
      'POST /parcel-setups',
      'PATCH /parcel-setups/:id',
      'POST /parcel-setups/:id/confirm',
    ]);

    // PATCH body — the client-built payload mirrors the server STRICT shape
    // exactly (generator numbering: '1'..'3', floor = ceil(i/3) = 1).
    const patchBody = JSON.parse(wire.patchBody() ?? '{}') as {
      payload?: { buildings?: Array<Record<string, unknown>> };
    };
    expect(patchBody).toEqual({
      payload: {
        buildings: [
          {
            address: 'הרצל 10',
            city: 'תל אביב',
            apartments: [
              { number: '1', floor: 1 },
              { number: '2', floor: 1 },
              { number: '3', floor: 1 },
            ],
          },
        ],
      },
    });
    expect(Object.keys(patchBody).sort()).toEqual(['payload']);
    const wireBuilding = patchBody.payload?.buildings?.[0] ?? {};
    expect(Object.keys(wireBuilding).sort()).toEqual(['address', 'apartments', 'city']);
    // No-PII paranoia — the public-record payload never carries PII keys.
    for (const banned of ['ownerName', 'nationalId', 'national_id', 'phone']) {
      expect(wire.patchBody() ?? '').not.toContain(banned);
    }

    // The buildings query was invalidated AND refetched — a fresh GET hit the
    // wire after the confirm 200.
    await expect
      .poll(() => wire.buildingsListGets(), {
        message: 'confirm must trigger a project-buildings refetch',
        timeout: 10_000,
      })
      .toBeGreaterThan(buildingsGetsBefore);

    // §AXIS-Network — zero stray writes (no direct POST /buildings bypass).
    expect(wire.strayWrites, `stray writes: ${wire.strayWrites.join(' | ')}`).toEqual([]);

    // §AXIS-U/Redirect — still on the project surface; the form values never
    // rode a query string (GET-fallback guard).
    expect(page.url()).toContain(`/he/projects/${PROJECT_ID}`);
    expect(page.url()).not.toMatch(/[?&](blockNumber|parcelNumber|subParcel|address|city)=/);

    // §AXIS-S (console) — fixture auto-asserts; explicit for clarity.
    expect(consoleErrors.count, 'no console errors during the parcel walk').toBe(0);
  });

  test('2) not_found: manual-entry copy, NO pre-filled city; confirm 409 parcel_skeleton_conflict → conflict copy, NO buildings refetch', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedManager(context);
    const wire = await installStubs(page, {
      providerStatus: 'not_found',
      confirmStatus: 409,
      confirmErrorCode: 'parcel_skeleton_conflict',
    });

    await openParcelSetup(page);
    await submitParcelForm(page);

    // Provider outcome — not found → the manual-path copy (§3: the flow is
    // NOT blocked; fallback ידני באותו מסך).
    await expect(page.getByText('לא נמצא — המשך בהזנה ידנית')).toBeVisible({ timeout: 10_000 });

    // City NOT pre-filled (no providerCity) — the user types it.
    await expect(page.locator('#b0-city')).toHaveValue('');
    await page.locator('#b0-address').fill('הרצל 12');
    await page.locator('#b0-city').fill('חולון');
    await page.locator('#b0-gen-floors').fill('2');
    await page.locator('#b0-gen-perFloor').fill('2');
    await expect(page.getByText('ייווצרו 1 בניינים ו-4 דירות')).toBeVisible();

    const buildingsGetsBefore = wire.buildingsListGets();
    const confirmBtn = page.getByRole('button', { name: 'אישור והקמה' });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/parcel-setups/${SETUP_ID}/confirm`) &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      confirmBtn.click(),
    ]);

    // The PATCH carried the manually-typed city.
    const patchBody = JSON.parse(wire.patchBody() ?? '{}') as {
      payload?: { buildings?: Array<Record<string, unknown>> };
    };
    expect(patchBody.payload?.buildings?.[0]?.['city']).toBe('חולון');

    // §AXIS-V — the pinned conflict copy.
    await expect(page.getByText('חלק מהבניינים/הדירות כבר קיימים בפרויקט')).toBeVisible({
      timeout: 10_000,
    });

    // Fail-closed: NO buildings refetch on a failed confirm.
    expect(wire.buildingsListGets()).toBe(buildingsGetsBefore);
    expect(page.url()).toContain(`/he/projects/${PROJECT_ID}`);

    // Chromium logs the stubbed 409 status line as a network console.error —
    // carve that one out (same pattern as J1 test 2 / J10); anything else is
    // a real bug.
    const real = consoleErrors.all.filter((e) => !/\b409\b/.test(e) && !/Conflict/i.test(e));
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });

  test('3) PATCH 409 parcel_setup_not_draft → "כבר אושר" shown and confirm NEVER fires (fail-closed ordering)', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedManager(context);
    const wire = await installStubs(page, {
      patchStatus: 409,
      patchErrorCode: 'parcel_setup_not_draft',
    });

    await openParcelSetup(page);
    await submitParcelForm(page);

    await expect(page.getByText('זוהה: תל אביב')).toBeVisible({ timeout: 10_000 });
    await page.locator('#b0-address').fill('הרצל 10');
    await page.locator('#b0-gen-floors').fill('1');
    await page.locator('#b0-gen-perFloor').fill('3');

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/parcel-setups/${SETUP_ID}`) && r.request().method() === 'PATCH',
        { timeout: 15_000 },
      ),
      page.getByRole('button', { name: 'אישור והקמה' }).click(),
    ]);

    // §AXIS-V — the pinned already-confirmed copy.
    await expect(page.getByText('כבר אושר')).toBeVisible({ timeout: 10_000 });

    // Fail-closed: the chain STOPS at the failed PATCH — no confirm POST.
    expect(wire.callOrder).toEqual(['POST /parcel-setups', 'PATCH /parcel-setups/:id']);

    const real = consoleErrors.all.filter((e) => !/\b409\b/.test(e) && !/Conflict/i.test(e));
    expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
    consoleErrors.clear();
  });
});
