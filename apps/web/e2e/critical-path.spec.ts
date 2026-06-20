/**
 * §E-CP — THE CRITICAL-PATH CHAIN (Phase-9 launch-gate item: "full
 * happy-path validates all core UI wiring").
 *
 * ONE spec that walks the core manager journey END-TO-END across every
 * core surface, fully STUBBED (page.route) — a UI-wiring regression net,
 * NOT a BE integration test. If ANY core page's wiring regresses (form
 * stops POSTing, redirect breaks, query stops firing, board stops
 * refetching), this chain breaks.
 *
 * THE CHAIN (each step's selectors grounded in the REAL page components):
 *   1. /he/login            — email+password form (login/page.tsx) →
 *                             POST /auth/login (stub 200 + Set-Cookie)
 *                             → router.push('/') → middleware → /he.
 *   2. /he/projects/new     — the A.S6 3-step wizard (data-hydrated gate,
 *                             "הבא" ×2, submit) → POST /projects (201)
 *                             → redirect /he/projects/:id.
 *   3. project page (tenants tab CTA "פתיחת רשימת הבניינים") →
 *      /projects/:id/buildings → "הוספת בניין" → buildings/new form →
 *      POST /projects/:id/buildings (201) → /he/buildings/:bid →
 *      "לרשימת הדירות" → apartments list → "הוספת דירה" →
 *      apartments/new form → POST /buildings/:bid/apartments (201)
 *      → /he/apartments/:aid.
 *   4. /he/owners/new       — owner form (name + national_id PII) →
 *                             POST /owners (201) → /he/owners/:oid.
 *   5. back on the project page, dashboard tab ("לוח בקרה") — the S5b
 *      campaign button ("שלח בקשת חתימה לכל הבעלים") + doc picker →
 *      POST /projects/:id/signature-campaign (201 {created:1,skipped:0}).
 *   6. the S5a board reflects: the campaign success invalidates
 *      ['projects'] → GET /projects/:id/signature-progress REFETCHES and
 *      the stub now reports signaturesPending:1 → the board text flips to
 *      "לא התקבלו חתימות · אחת ממתינה" (wiring proof: mutation→invalidate→
 *      refetch→render).
 *   7. the header "ייצוא לאקסל" button (A.S15) →
 *      GET /projects/:id/export?format=xlsx → success toast
 *      "ההורדה הסתיימה".
 *
 * HONEST SUBSTITUTIONS (pragmatism, documented):
 *   - Step 4 uses the CANONICAL owners add flow `/he/owners/new`
 *     (j2d-grounded). The apartment detail page has no direct
 *     "add owner" affordance — linking the owner to the apartment is the
 *     D.25 ownerships set-replace flow (its own surface + spec, j2e) and
 *     is deliberately NOT in this chain. The chain still proves the
 *     owner-create wiring + the D.19 PII-never-in-URL contract.
 *   - Step 5 uses the S5b CAMPAIGN button on the project board (fans the
 *     stubbed finalized document out to ALL project owners — including
 *     the one just created) rather than the per-owner
 *     /signature-requests/new picker form. The campaign IS the
 *     launch-gate signature entry point on the board, and its success →
 *     board-refetch wiring is the step-6 assertion.
 *
 * CHAIN-WIDE ASSERTIONS:
 *   - Call-order ledger: the EXACT write sequence on the wire
 *     (login → project → building → apartment → owner → campaign →
 *     export), nothing reordered, nothing doubled.
 *   - Zero stray writes (any non-GET that reaches the catch-all fails).
 *   - No PII in ANY request URL (national_id / phone / password trap on
 *     every request the page makes, the whole session).
 *   - Cookies: the login Set-Cookie is applied (context cookie httpOnly)
 *     AND actually rides a later create POST.
 *   - Idempotency-Key on the create POSTs (postIdempotent contract).
 *   - Every touched <form> carries method="post" (GET-fallback
 *     credential-leak guard, repo DoD).
 *   - §P0-3 console guardrail via the shared fixture (zero console
 *     errors — every stub in this chain returns 2xx).
 *
 * Stub style mirrors p3c-parcel-setup.spec.ts: catch-all registered
 * FIRST (Playwright matches LAST-registered first), specific routes
 * after; non-matching methods route.fallback() into the stray-write trap.
 * SSR traffic (layout getMe, org/stats) is served by the Node-side mock
 * backend (e2e/mock-backend.ts) via API_BACKEND_URL — not by page.route.
 */
import { test, expect } from './fixtures';

const ORG_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-00000c901001';
const BUILDING_ID = '00000000-0000-4000-8000-00000c902001';
const APARTMENT_ID = '00000000-0000-4000-8000-00000c903001';
const OWNER_ID = '00000000-0000-4000-8000-00000c904001';
const DOC_ID = '00000000-0000-4000-8000-00000c905001';

const CREATED_AT = '2026-06-12T08:00:00.000Z';

const LOGIN = { email: 'manager@alpha.dev', password: 'TestPassword123!' } as const;

const PROJECT_NAME = 'מתחם הרצל';

/** PII fixture values — the chain-wide URL trap greps every request URL
 *  for these. Luhn-valid fictitious national id (same as j2d). */
const OWNER_PII = {
  name: 'דנה כהן',
  national_id: '999000441',
  phone: '0501234567',
} as const;

/** GET /projects/:id parses ProjectListItemSchema; the 201 parses
 *  ProjectSchema (subset — extra keys are stripped). Shape proven by
 *  p3c-parcel-setup.spec.ts + j2. */
const PROJECT = {
  id: PROJECT_ID,
  organizationId: ORG_ID,
  name: PROJECT_NAME,
  type: 'tama38_2',
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

/** BuildingSchema shape proven by j2b. */
const BUILDING = {
  id: BUILDING_ID,
  projectId: PROJECT_ID,
  address: 'הרצל 10',
  city: 'תל אביב',
  block: null,
  parcel: null,
  subparcel: null,
  aptCount: 0,
  notes: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
};

/** ApartmentSchema shape proven by j2c (incl. the D.39 migration-0035
 *  fields unitType/areaSqm/entrance). */
const APARTMENT = {
  id: APARTMENT_ID,
  buildingId: BUILDING_ID,
  number: '3',
  floor: 1,
  sizeSqm: null,
  rooms: null,
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

/** OwnerSchema shape proven by j2d (masked PII on the read wire). */
const OWNER = {
  id: OWNER_ID,
  organizationId: ORG_ID,
  name: OWNER_PII.name,
  email: null,
  nationalIdMasked: '•••••••41',
  phoneMasked: '•••••4567',
  notes: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
};

/** DocumentSchema — the "finalized" project document the S5b picker
 *  offers (non-archived + projectId match is the picker's filter). */
const PROJECT_DOC = {
  id: DOC_ID,
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
  apartmentId: null,
  name: 'הסכם תמ"א — נוסח סופי',
  type: 'agreement',
  mimeType: 'application/pdf',
  sizeBytes: 24_576,
  contentHash: 'sha256:e2e-critical-path-doc',
  uploadedBy: MANAGER_USER_ID,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
};

/** Browser-side GET /me (UserProfileSchema) — the permission gates the
 *  chain's CTAs render on. Deliberately WITHOUT apartments.update so the
 *  apartment detail page doesn't mount the tabu-review section (its own
 *  journey — tabu-review.e2e.spec.ts). */
const PROFILE = {
  id: MANAGER_USER_ID,
  name: 'מיכל מנהלת',
  email: 'manager@alpha.dev',
  role: 'manager',
  avatarColor: null,
  organization: { id: ORG_ID, name: 'Alpha', slug: 'alpha-dev' },
  view_owner_pii: true,
  permissions: [
    'projects.read',
    'projects.create',
    'buildings.read',
    'buildings.create',
    'apartments.read',
    'apartments.create',
    'owners.read',
    'owners.create',
    'documents.read',
    'documents.create',
    'signature_requests.send',
    'export.run',
  ],
};

interface ChainWire {
  /** The writes (+ the export GET) we OWN, in wire order. */
  callOrder: string[];
  /** Non-GETs that fell through to the catch-all — must stay empty. */
  strayWrites: string[];
  /** EVERY request URL the page issued — the chain-wide PII trap. */
  requestUrls: string[];
  projectPostBody: () => string | null;
  projectPostIdemKey: () => string | null;
  projectPostCookie: () => string | null;
  buildingPostBody: () => string | null;
  apartmentPostBody: () => string | null;
  ownerPostBody: () => string | null;
  campaignBody: () => string | null;
  campaignIdemKey: () => string | null;
  progressGets: () => number;
}

/**
 * Full browser-side stub surface for the chain. Catch-all FIRST; the
 * specific routes below are registered AFTER so they win (Playwright
 * matches last-registered first). Every handler branches on method and
 * `route.fallback()`s what it doesn't own, so unexpected writes land in
 * the catch-all stray trap.
 */
async function installStubs(page: import('@playwright/test').Page): Promise<ChainWire> {
  const callOrder: string[] = [];
  const strayWrites: string[] = [];
  const requestUrls: string[] = [];
  let projectPostBody: string | null = null;
  let projectPostIdemKey: string | null = null;
  let projectPostCookie: string | null = null;
  let buildingPostBody: string | null = null;
  let apartmentPostBody: string | null = null;
  let ownerPostBody: string | null = null;
  let campaignBody: string | null = null;
  let campaignIdemKey: string | null = null;
  let progressGets = 0;
  // Step-6 state: the campaign success flips the progress the stub reports.
  let signaturesPending = 0;

  // Chain-wide PII trap — EVERY request URL (pages, assets, API).
  page.on('request', (req) => {
    requestUrls.push(req.url());
  });

  // Benign catch-all (notifications, lists, …) + stray-write trap.
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

  // E2 Wave-2 B1 — the board-first home (the landing surface after login) is a
  // client island that fetches /org/signature-pulse on mount. The benign
  // catch-all above answers every GET with `{ data: [] }`, which FAILS the
  // home's SignaturePulseSchema parse (it expects { buckets, attention,
  // needsHuman }) → the home would render its DataState error panel. Stub a
  // valid (all-clear) pulse so the home renders its calm content cleanly and
  // the §P0-3 console guard stays green. attention:[] → the reward empty-state.
  await page.route('**/api/v1/org/signature-pulse', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          buckets: { stalled: 0, expiringSoon: 0, needsHuman: 0, onTrack: 0 },
          attention: [],
          needsHuman: [],
        },
      }),
    });
  });

  // Browser-side /me — permission gates (the SSR /me is served by the
  // Node-side mock backend, out of page.route reach).
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: PROFILE }),
    });
  });

  // 1) POST /auth/login — the call we OWN + Set-Cookie (j1 pattern:
  // single Set-Cookie value; Chromium parses multi-value unreliably).
  await page.route('**/api/v1/auth/login', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.fallback();
      return;
    }
    callOrder.push('POST /auth/login');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Set-Cookie': 'access_token=e2e-manager-access-jwt; Path=/; HttpOnly; SameSite=Lax',
      },
      body: JSON.stringify({
        data: {
          user: {
            id: MANAGER_USER_ID,
            name: PROFILE.name,
            email: PROFILE.email,
            role: 'manager',
            organization: PROFILE.organization,
          },
        },
      }),
    });
  });

  // 2) POST /projects (exact path — the list GET carries a query string
  // and falls through to the catch-all).
  await page.route('**/api/v1/projects', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.fallback();
      return;
    }
    callOrder.push('POST /projects');
    projectPostBody = req.postData();
    projectPostIdemKey = await req.headerValue('idempotency-key');
    projectPostCookie = await req.headerValue('cookie');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: PROJECT }),
    });
  });

  // Project detail GET — the page the wizard redirects to.
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

  // 3a) Buildings under the project — GET list + POST create.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/buildings*`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      callOrder.push('POST /projects/:id/buildings');
      buildingPostBody = req.postData();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: BUILDING }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
    });
  });

  await page.route(`**/api/v1/buildings/${BUILDING_ID}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: BUILDING }),
    });
  });

  // 3b) Apartments under the building — GET list + POST create.
  await page.route(`**/api/v1/buildings/${BUILDING_ID}/apartments*`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      callOrder.push('POST /buildings/:id/apartments');
      apartmentPostBody = req.postData();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: APARTMENT }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
    });
  });

  await page.route(`**/api/v1/apartments/${APARTMENT_ID}`, async (route) => {
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

  // 4) POST /owners (exact path — owners list GETs carry a query).
  await page.route('**/api/v1/owners', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.fallback();
      return;
    }
    callOrder.push('POST /owners');
    ownerPostBody = req.postData();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: OWNER }),
    });
  });

  await page.route(`**/api/v1/owners/${OWNER_ID}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: OWNER }),
    });
  });

  // 5) The S5b doc picker list — one finalized project document.
  await page.route('**/api/v1/documents*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [PROJECT_DOC],
        page: { limit: 25, cursor: null, has_more: false },
      }),
    });
  });

  // 5) POST /projects/:id/signature-campaign — the fan-out. Success flips
  // the progress state the step-6 board refetch observes.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/signature-campaign`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.fallback();
      return;
    }
    callOrder.push('POST /projects/:id/signature-campaign');
    campaignBody = req.postData();
    campaignIdemKey = await req.headerValue('idempotency-key');
    signaturesPending = 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { created: 1, skipped: 0, total: 1 } }),
    });
  });

  // 6) The S5a board read — SignatureProgressSchema. Counts the GETs so
  // the test can prove the post-campaign REFETCH actually hit the wire.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/signature-progress`, async (route) => {
    progressGets += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          totalApartments: 1,
          apartmentsConsented: 0,
          signaturesSigned: 0,
          signaturesPending,
          targetSignaturePct: 66,
          consentedPct: 0,
          metThreshold: false,
          // E2 Wave-1 B0 — share-weighted consent basis (required by the wire
          // SignatureProgressSchema parse). 0% here (no signatures yet).
          basis: 'share',
        },
      }),
    });
  });

  // S5d drill-down under the board (mounts collapsed; stubbed empty).
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

  // 7) GET /projects/:id/export?format=xlsx — streamed xlsx (stub bytes).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/export*`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    callOrder.push('GET /projects/:id/export');
    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      headers: { 'Content-Disposition': 'attachment; filename="project-export.xlsx"' },
      body: 'PK-e2e-fake-xlsx-bytes',
    });
  });

  return {
    callOrder,
    strayWrites,
    requestUrls,
    projectPostBody: () => projectPostBody,
    projectPostIdemKey: () => projectPostIdemKey,
    projectPostCookie: () => projectPostCookie,
    buildingPostBody: () => buildingPostBody,
    apartmentPostBody: () => apartmentPostBody,
    ownerPostBody: () => ownerPostBody,
    campaignBody: () => campaignBody,
    campaignIdemKey: () => campaignIdemKey,
    progressGets: () => progressGets,
  };
}

/**
 * Settle a FULL page load before interacting. Pages reached via
 * `page.goto` paint SSR HTML first; a fill/click during the hydration
 * window hits the native (pre-React) form — react-hook-form values are
 * lost and a pre-hydration submit fires the browser-native POST
 * navigation instead of the API call (observed live on /owners/new).
 * Client-side route transitions don't need this (React is already
 * running). With EVERY API stubbed, networkidle is deterministic here.
 */
async function settleAfterGoto(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle', { timeout: 60_000 });
}

/** §AXIS-V — the SSR method="post" guard every touched form must pass. */
async function expectMethodPost(form: import('@playwright/test').Locator, label: string) {
  await expect(form, `${label} form rendered`).toBeVisible({ timeout: 15_000 });
  expect((await form.getAttribute('method'))?.toLowerCase(), `${label}: method="post"`).toBe(
    'post',
  );
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test.describe('§E-CP — critical-path chain (Phase-9 launch gate)', () => {
  test('login → project → building → apartment → owner → campaign → board reflects → export', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // The chain crosses ~12 dev-server route compiles (~3s each cold);
    // the default 30s budget is for single-surface specs.
    test.setTimeout(300_000);

    const wire = await installStubs(page);

    // ── 1) LOGIN ─────────────────────────────────────────────────────
    await page.goto('/he/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const loginForm = page.locator('form').first();
    await expectMethodPost(loginForm, 'login');
    await settleAfterGoto(page);

    await page.locator('input#email').fill(LOGIN.email);
    await page.locator('input#password').fill(LOGIN.password);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      loginForm.locator('button[type="submit"]').click(),
    ]);

    // router.push('/') → next-intl middleware → /he (dashboard home; SSR
    // getMe served by the Node-side mock backend with the fresh cookie).
    await page.waitForURL(/\/he\/?$/, { timeout: 60_000 });

    // §AXIS-Cookies — the stubbed Set-Cookie was APPLIED to the context.
    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'access_token');
    expect(access, 'access_token cookie applied from login Set-Cookie').toBeDefined();
    expect(access?.httpOnly, 'access_token HttpOnly').toBe(true);

    // §AXIS-URL — credentials never rode the URL (GET-fallback guard).
    expect(page.url()).not.toContain(LOGIN.password);
    expect(page.url()).not.toMatch(/[?&](email|password)=/);

    // ── 2) CREATE PROJECT (A.S6 wizard) ──────────────────────────────
    await page.goto('/he/projects/new', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const wizardForm = page.locator('form').first();
    await expectMethodPost(wizardForm, 'project wizard');
    // §FUNC-4 — the wizard is a controlled-input form; fill only after
    // the product's own hydration signal (j2 lesson — pre-hydration fills
    // are wiped by the controlled re-render).
    await expect(wizardForm).toHaveAttribute('data-hydrated', 'true', { timeout: 15_000 });

    await page.locator('input#name').fill(PROJECT_NAME);
    await page.locator('select#type').selectOption('tama38_2');
    await page.getByRole('button', { name: 'הבא' }).click(); // step 1 → 2
    await page.getByRole('button', { name: 'הבא' }).click(); // step 2 → 3 (empty structure)
    await page.locator('button[type="submit"]').click();

    // Redirect = success signal (causally downstream of the captured POST).
    await page.waitForURL(new RegExp(`/he/projects/${PROJECT_ID}$`), { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible({
      timeout: 15_000,
    });

    const projectBody = JSON.parse(wire.projectPostBody() ?? '{}') as Record<string, unknown>;
    expect(projectBody['name']).toBe(PROJECT_NAME);
    expect(projectBody['type']).toBe('tama38_2');
    // §AXIS-Cookies — the create POST CARRIED the login-minted cookie.
    expect(wire.projectPostCookie() ?? '').toContain('access_token=e2e-manager-access-jwt');
    // postIdempotent contract (Doc 06 §5.7).
    expect(wire.projectPostIdemKey()).toMatch(UUID_V4_RE);

    // ── 3a) ADD A BUILDING (tenants-tab CTA → buildings list → form) ─
    await page.getByRole('link', { name: 'פתיחת רשימת הבניינים' }).click();
    await page.waitForURL(new RegExp(`/he/projects/${PROJECT_ID}/buildings$`), {
      timeout: 60_000,
    });
    await page.getByRole('link', { name: 'הוספת בניין' }).click();
    await page.waitForURL(new RegExp(`/he/projects/${PROJECT_ID}/buildings/new$`), {
      timeout: 60_000,
    });

    const buildingForm = page.locator('form').first();
    await expectMethodPost(buildingForm, 'building create');
    await page.locator('input#address').fill(BUILDING.address);
    await page.locator('input#city').fill(BUILDING.city);
    await page.locator('button[type="submit"]').click();

    await page.waitForURL(new RegExp(`/he/buildings/${BUILDING_ID}$`), { timeout: 60_000 });
    const buildingBody = JSON.parse(wire.buildingPostBody() ?? '{}') as Record<string, unknown>;
    expect(buildingBody['address']).toBe(BUILDING.address);
    expect(buildingBody['city']).toBe(BUILDING.city);

    // ── 3b) ADD AN APARTMENT (building page → list → form) ───────────
    await page.getByRole('link', { name: 'לרשימת הדירות' }).click();
    await page.waitForURL(new RegExp(`/he/buildings/${BUILDING_ID}/apartments$`), {
      timeout: 60_000,
    });
    await page.getByRole('link', { name: 'הוספת דירה' }).click();
    await page.waitForURL(new RegExp(`/he/buildings/${BUILDING_ID}/apartments/new$`), {
      timeout: 60_000,
    });

    const apartmentForm = page.locator('form').first();
    await expectMethodPost(apartmentForm, 'apartment create');
    await page.locator('input#number').fill(APARTMENT.number);
    await page.locator('button[type="submit"]').click();

    await page.waitForURL(new RegExp(`/he/apartments/${APARTMENT_ID}$`), { timeout: 60_000 });
    const apartmentBody = JSON.parse(wire.apartmentPostBody() ?? '{}') as Record<string, unknown>;
    expect(apartmentBody['number']).toBe(APARTMENT.number);

    // ── 4) ADD AN OWNER (canonical /owners/new flow — see header note) ─
    await page.goto('/he/owners/new', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const ownerForm = page.locator('form').first();
    await expectMethodPost(ownerForm, 'owner create');
    await settleAfterGoto(page);
    await page.locator('input#name').fill(OWNER_PII.name);
    await page.locator('input#national_id').fill(OWNER_PII.national_id);
    await page.locator('input#phone').fill(OWNER_PII.phone);
    // Arm the API-POST wait BEFORE the click — a pre-hydration native
    // submit (the GET/POST-fallback failure mode) would navigate without
    // ever calling the API and fail HERE, loudly, not downstream.
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/v1/owners') && r.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    await page.waitForURL(new RegExp(`/he/owners/${OWNER_ID}$`), { timeout: 60_000 });
    const ownerBody = JSON.parse(wire.ownerPostBody() ?? '{}') as Record<string, unknown>;
    expect(ownerBody['name']).toBe(OWNER_PII.name);
    expect(ownerBody['national_id']).toBe(OWNER_PII.national_id);
    // §AXIS-URL (D.19) — the PII rode the POST body, NEVER the URL.
    expect(page.url()).not.toContain(OWNER_PII.national_id);
    expect(page.url()).not.toContain(OWNER_PII.phone);

    // ── 5) SIGNATURE CAMPAIGN on the project board (S5b) ─────────────
    await page.goto(`/he/projects/${PROJECT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible({
      timeout: 15_000,
    });
    await settleAfterGoto(page);
    await page.getByRole('tab', { name: 'לוח בקרה' }).click();

    // S5a board baseline — pre-campaign progress (0 pending on the wire).
    await expect(page.getByText('0 מתוך 1 דירות הסכימו')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('לא התקבלו חתימות · אין ממתינות')).toBeVisible();

    await page.getByTestId('signature-campaign-toggle').click();
    const docSelect = page.getByTestId('signature-campaign-doc-select');
    await expect(docSelect).toBeVisible({ timeout: 15_000 });
    await docSelect.selectOption(DOC_ID);

    const progressGetsBeforeCampaign = wire.progressGets();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/projects/${PROJECT_ID}/signature-campaign`) &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByTestId('signature-campaign-confirm').click(),
    ]);

    // Strict SignatureCampaignInput body + idempotency.
    const campaign = JSON.parse(wire.campaignBody() ?? '{}') as Record<string, unknown>;
    expect(campaign).toEqual({ documentId: DOC_ID });
    expect(wire.campaignIdemKey()).toMatch(UUID_V4_RE);

    // The S5b result toast (created/skipped tallies).
    await expect(page.getByTestId('signature-campaign-toast')).toHaveText('1 נשלחו · 0 דולגו', {
      timeout: 15_000,
    });

    // ── 6) THE BOARD REFLECTS — invalidate→refetch→render wiring ─────
    // The campaign hook invalidates ['projects'] → useSignatureProgress
    // refetches → the stub now reports signaturesPending:1 → the board
    // signedCount line flips. All three hops asserted.
    await expect(page.getByText('לא התקבלו חתימות · אחת ממתינה')).toBeVisible({
      timeout: 15_000,
    });
    expect(
      wire.progressGets(),
      'campaign success must REFETCH the signature-progress board',
    ).toBeGreaterThan(progressGetsBeforeCampaign);

    // ── 7) EXPORT (ייצוא לאקסל, A.S15) ───────────────────────────────
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/projects/${PROJECT_ID}/export`) &&
          r.request().method() === 'GET',
        { timeout: 15_000 },
      ),
      page.getByTestId('export-xlsx-button').click(),
    ]);
    await expect(page.getByTestId('export-toast-ok')).toHaveText('ההורדה הסתיימה', {
      timeout: 15_000,
    });

    // ── CHAIN-WIDE ASSERTIONS ────────────────────────────────────────
    // §AXIS-Network — the EXACT call-order ledger, nothing doubled.
    expect(wire.callOrder).toEqual([
      'POST /auth/login',
      'POST /projects',
      'POST /projects/:id/buildings',
      'POST /buildings/:id/apartments',
      'POST /owners',
      'POST /projects/:id/signature-campaign',
      'GET /projects/:id/export',
    ]);

    // Zero stray writes — no page in the chain fired a write we don't own.
    expect(wire.strayWrites, `stray writes: ${wire.strayWrites.join(' | ')}`).toEqual([]);

    // §AXIS-URL chain-wide PII trap — NO request URL the whole session
    // carried the national_id / phone / password (D.19 + GET-fallback).
    const piiUrls = wire.requestUrls.filter(
      (u) =>
        u.includes(OWNER_PII.national_id) ||
        u.includes(OWNER_PII.phone) ||
        u.includes(LOGIN.password) ||
        u.includes(encodeURIComponent(LOGIN.password)),
    );
    expect(piiUrls, `PII leaked into request URLs: ${piiUrls.join(' | ')}`).toEqual([]);

    // §AXIS-S (console) — fixture auto-asserts in afterEach; explicit here
    // for the chain (every stub is 2xx, so ANY console error is a real bug).
    expect(consoleErrors.count, 'console clean across the whole chain').toBe(0);
  });
});
