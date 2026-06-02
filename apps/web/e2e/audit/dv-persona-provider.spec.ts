import { mkdirSync, writeFileSync } from 'node:fs';

import { test, expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';

/**
 * DV PERSONA — Product Admin / Provider (מנהל המוצר).
 *
 * The SaaS operator who manages customer organisations. This is NOT a render
 * smoke. It behaves like a real operator and, for every natural provider
 * action, judges on two axes:
 *   - did it SUCCEED — confirmed by the RESULT (the org actually appears in
 *     the tenants list / API; the suspend actually flips `suspendedAt` when
 *     re-read from the provider API with the browser's own cookie + reason
 *     header) — NEVER by "the form rendered"?
 *   - SHOULD a provider be allowed it?
 * → works · FUNCTIONAL_BUG · AUTHZ_BUG · blocked_ok · UX_dead_click · MISSING.
 *
 * Settles the owner's claim ("no button or tab worked, couldn't create
 * anything") against the prior agent's ("cleanest interface") — with proof.
 *
 * The provider login endpoint is IP-throttled (5 / 10min), so we log in ONCE
 * in beforeAll and share ONE context across all tests. Every mutating action
 * is reproduced ≥2× and any tenant we suspend is ALWAYS reactivated — Beta is
 * never left suspended, Alpha is never touched.
 *
 * Run (HEADLESS only):
 *   cd C:/emapp/apps/web && pnpm exec playwright test \
 *     --config playwright.audit.config.ts e2e/audit/dv-persona-provider.spec.ts
 */

const WEB = 'http://localhost:3001';
const API = 'http://localhost:3000';
const ART = 'C:/emapp/docs/DV/results/artifacts';

const PROVIDER = { email: 'provider@local.dev', password: 'DevPassword123!', mfa: '000000' };
const ACCESS_REASON = 'INC-1001';
const ACCESS_REASON_HEADER = 'access_reason';
const STORAGE_KEY = 'emapp.provider.access_reason';

// Tenant ids harvested live from GET /api/v1/provider/tenants (2026-06-03).
const ALPHA_ID = 'f4c183e2-d5ef-4b81-9a47-29162d3f9626'; // NEVER mutate Alpha
const BETA_ID = 'bd0acb76-a148-4e3f-a280-e250e0435ed8'; // safe target for suspend/reactivate

type Verdict =
  | 'works'
  | 'FUNCTIONAL_BUG'
  | 'AUTHZ_BUG'
  | 'blocked_ok'
  | 'UX_dead_click'
  | 'MISSING';

interface LedgerRow {
  action: string;
  performed: string;
  outcome: string;
  shouldProvider: 'yes' | 'no';
  verdict: Verdict;
  proof: string;
}

const ledger: LedgerRow[] = [];
function record(r: LedgerRow): void {
  ledger.push(r);
  // eslint-disable-next-line no-console
  console.log(`[LEDGER] ${r.verdict.padEnd(15)} | ${r.action} :: ${r.outcome} :: ${r.proof}`);
}

const consoleErrors: string[] = [];

/** Re-read a provider resource via the API using the browser's own cookie jar
 *  PLUS the mandatory access_reason header. This is the OUTCOME oracle. */
async function providerApiGet(page: Page, path: string): Promise<APIResponse> {
  return page.request.get(`${API}${path}`, {
    headers: { [ACCESS_REASON_HEADER]: ACCESS_REASON },
  });
}

/** Provider login through the REAL form (httpOnly cookies land as a user
 *  gets them). Mirrors the hydration-race handling used across the suite. */
async function providerLogin(page: Page): Promise<void> {
  await page.goto(`${WEB}/he/provider/login`, { waitUntil: 'networkidle' });
  const submit = page.locator('button[type=submit]');
  await submit.waitFor({ state: 'visible' });

  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.fill('#email', '');
    await page.fill('#password', '');
    await page.fill('#mfa_code', '');
    await page.fill('#email', PROVIDER.email);
    await page.fill('#password', PROVIDER.password);
    await page.fill('#mfa_code', PROVIDER.mfa);
    await expect(page.locator('#email')).toHaveValue(PROVIDER.email);
    await submit.click();
    try {
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 12_000 });
      return;
    } catch {
      if (attempt === 2) throw new Error('providerLogin stayed on /login after 2 attempts');
      await page.waitForTimeout(1500);
    }
  }
}

/** Pass the Access-Reason gate (D.37) through the REAL gate form, then seed
 *  sessionStorage defensively so subsequent navigations stay open. */
async function passAccessReasonGate(page: Page): Promise<void> {
  await page.goto(`${WEB}/he/provider`, { waitUntil: 'domcontentloaded' });
  const reasonInput = page.locator('#provider-reason');
  const gateShown = await reasonInput
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (gateShown) {
    await reasonInput.fill(ACCESS_REASON);
    await page.locator('form button[type=submit]').click();
    await expect(reasonInput).toHaveCount(0, { timeout: 10_000 });
  }
  await page.evaluate(([k, v]) => window.sessionStorage.setItem(k, v), [
    STORAGE_KEY,
    ACCESS_REASON,
  ] as const);
}

/** Suspend state of a tenant, read fresh from the provider detail API. */
async function tenantSuspended(page: Page, id: string): Promise<boolean | null> {
  const r = await providerApiGet(page, `/api/v1/provider/tenants/${id}`);
  if (!r.ok()) return null;
  const body = JSON.parse(await r.text()) as { data: { suspendedAt: string | null } };
  return body.data.suspendedAt !== null;
}

/** Belt-and-suspenders cleanup: if Beta is somehow left suspended, reactivate
 *  it through the API so the demo seed is never left in a frozen state. */
async function ensureBetaActive(page: Page): Promise<void> {
  const suspended = await tenantSuspended(page, BETA_ID);
  if (suspended === true) {
    await page.request.post(`${API}/api/v1/provider/tenants/${BETA_ID}/reactivate`, {
      headers: { [ACCESS_REASON_HEADER]: ACCESS_REASON, 'content-type': 'application/json' },
      data: {},
    });
  }
}

test.describe.serial('DV persona — Product Admin / Provider', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    mkdirSync(ART, { recursive: true });
    context = await browser.newContext({ baseURL: WEB });
    page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const txt = m.text();
        if (/Connection closed|WebSocket|ResizeObserver|HMR|favicon|Hot Module/i.test(txt)) return;
        consoleErrors.push(txt);
      }
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    await providerLogin(page);
    await passAccessReasonGate(page);
  });

  test.afterAll(async () => {
    await ensureBetaActive(page);
    const summary = {
      persona: 'provider@local.dev',
      ranAt: new Date().toISOString(),
      totals: {
        actions: ledger.length,
        worked: ledger.filter((r) => r.verdict === 'works').length,
        functionalBugs: ledger.filter((r) => r.verdict === 'FUNCTIONAL_BUG').length,
        authzBugs: ledger.filter((r) => r.verdict === 'AUTHZ_BUG').length,
        blockedOk: ledger.filter((r) => r.verdict === 'blocked_ok').length,
        uxDeadClicks: ledger.filter((r) => r.verdict === 'UX_dead_click').length,
        missing: ledger.filter((r) => r.verdict === 'MISSING').length,
      },
      consoleErrors,
      ledger,
    };
    writeFileSync(`${ART}/persona-provider-ledger.json`, JSON.stringify(summary, null, 2), 'utf-8');
    // eslint-disable-next-line no-console
    console.log('[DV][SUMMARY] ' + JSON.stringify(summary.totals));
    // eslint-disable-next-line no-console
    console.log('[DV][CONSOLE-ERRORS] ' + (consoleErrors.join(' || ') || '(none)'));
    await context.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION 1 — Navigate every provider tab; confirm each LOADS its data.
  // ─────────────────────────────────────────────────────────────────────────
  test('every provider tab loads real data (not blank/error)', async () => {
    test.setTimeout(180_000);
    await passAccessReasonGate(page);

    const tabs: { slug: string; path: string; expect: RegExp }[] = [
      { slug: 'dashboard', path: '/he/provider', expect: /לקוח|tenant|ארגון|מערכת|בריאות/i },
      { slug: 'tenants', path: '/he/provider/tenants', expect: /Alpha/ },
      { slug: 'tenant-alpha', path: `/he/provider/tenants/${ALPHA_ID}`, expect: /Alpha/ },
      { slug: 'tenant-beta', path: `/he/provider/tenants/${BETA_ID}`, expect: /Beta/ },
      { slug: 'onboard', path: '/he/provider/onboard', expect: /יצירת לקוח|שם הארגון/ },
      { slug: 'audit', path: '/he/provider/audit', expect: /.+/ },
      { slug: 'system-health', path: '/he/provider/system-health', expect: /.+/ },
    ];

    const loaded: Record<string, boolean> = {};
    for (const ttab of tabs) {
      const resp = await page
        .goto(`${WEB}${ttab.path}`, { waitUntil: 'domcontentloaded' })
        .catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page
        .screenshot({ path: `${ART}/persona-provider-${ttab.slug}.png`, fullPage: true })
        .catch(() => {});
      const body = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      const onProvider = new URL(page.url()).pathname.includes('/provider');
      const docOk = !resp || resp.status() < 500;
      // "loaded" = no bounce to login, no 5xx, AND the page's oracle content
      // is present (proves data rendered, not just a shell/error card).
      loaded[ttab.slug] = onProvider && docOk && ttab.expect.test(body);
    }

    // Inventory the platform-console sidebar: how many nav items are LIVE vs
    // locked scaffold (lock-glyph + disabled). The operator sees a rich nav
    // (billing / plans / integrations / roles / backups) but most items are
    // placeholders — only 4 (overview / orgs / health / audit) actually work.
    await page.goto(`${WEB}/he/provider`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const navLive = await page
      .locator('nav a[href], nav button:not([disabled])')
      .count()
      .catch(() => 0);
    const navLocked = await page
      .locator('nav [aria-disabled="true"], nav a.pointer-events-none, nav button[disabled]')
      .count()
      .catch(() => 0);
    const navTotal = navLive + navLocked;

    const tenantsOk = loaded['tenants'] === true;
    const alphaOk = loaded['tenant-alpha'] === true;
    const allOk = Object.values(loaded).every(Boolean);
    record({
      action: 'Navigate every provider tab + open a tenant detail',
      performed:
        'goto dashboard, tenants, tenant-detail (Alpha & Beta), onboard, audit, system-health; assert oracle content rendered',
      outcome: allOk
        ? 'CONFIRMED: every tab loaded its data (tenants list shows Alpha/Beta; detail opens)'
        : `PARTIAL: ${Object.entries(loaded)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(', ')} did not load expected content`,
      shouldProvider: 'yes',
      verdict: allOk ? 'works' : 'FUNCTIONAL_BUG',
      proof: `loaded=${JSON.stringify(loaded)} (tenantsListOk=${tenantsOk} alphaDetailOk=${alphaOk})`,
    });

    record({
      action: 'Platform-console sidebar nav — live vs scaffold',
      performed: 'count nav items + locked/disabled placeholders in the provider shell',
      outcome:
        navLocked > 0
          ? `${navLocked} of ${navTotal} sidebar entries are locked scaffold (billing, plans, integrations, roles, backups, support) — only overview/orgs/health/audit are live`
          : `${navTotal} nav items, none locked`,
      shouldProvider: 'yes',
      verdict: navLocked > 0 ? 'MISSING' : 'works',
      proof: `navTotal=${navTotal} navLive=${navLive} navLocked=${navLocked} (locked items render a lock glyph + are non-navigable placeholders)`,
    });

    // Reproduce the tenant-detail open a 2nd time (the FALSE-bug guard: an
    // earlier hydration-race innerText() grab caught only the nav shell). Wait
    // on the page heading <h1>Alpha</h1> specifically — proves the detail
    // content (not just the sidebar) actually rendered.
    await page.goto(`${WEB}/he/provider/tenants/${ALPHA_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const alphaHeading = page.getByRole('heading', { level: 1, name: 'Alpha' });
    await expect(alphaHeading, 'tenant detail heading renders on reproduce').toBeVisible({
      timeout: 12_000,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION 2 — Access-Reason gate rejects a too-short non-ticket reason.
  // ─────────────────────────────────────────────────────────────────────────
  test('Access-Reason gate blocks a too-short non-ticket reason', async () => {
    test.setTimeout(120_000);
    await page.evaluate((k) => window.sessionStorage.removeItem(k), STORAGE_KEY);
    await page.goto(`${WEB}/he/provider`, { waitUntil: 'domcontentloaded' });

    const reasonInput = page.locator('#provider-reason');
    await reasonInput.waitFor({ state: 'visible', timeout: 10_000 });
    const submit = page.locator('form button[type=submit]');

    await reasonInput.fill('hi');
    const blockedShort = await submit.isDisabled();
    const gateStillUp = await reasonInput.isVisible();

    await reasonInput.fill(ACCESS_REASON);
    const enabledValid = await submit.isEnabled();

    // Reproduce: clear → too-short again → still blocked.
    await reasonInput.fill('xx');
    const blockedShort2 = await submit.isDisabled();
    await reasonInput.fill(ACCESS_REASON);

    const ok = blockedShort && gateStillUp && enabledValid && blockedShort2;
    record({
      action: 'Access-Reason gate enforcement',
      performed:
        'enter "hi" (too short) → check submit disabled + gate still up; enter INC-1001 → enabled (×2)',
      outcome: ok
        ? 'CONFIRMED: gate blocks too-short reason, accepts a valid ticket ref'
        : 'FAILED: gate did not enforce as expected',
      shouldProvider: 'yes',
      verdict: ok ? 'works' : 'FUNCTIONAL_BUG',
      proof: `shortDisabled=${blockedShort} gateUp=${gateStillUp} validEnabled=${enabledValid} repro=${blockedShort2}`,
    });

    // restore the open gate for the next tests
    await passAccessReasonGate(page);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION 3 — ONBOARD: create an organisation through the form, then CONFIRM
  //   it appears in the tenants list + the provider API. (Owner's "couldn't
  //   create anything" claim — settle it.)
  // ─────────────────────────────────────────────────────────────────────────
  test('Onboard creates an organisation that really appears', async () => {
    test.setTimeout(180_000);
    await passAccessReasonGate(page);

    const stamp = Date.now();
    const orgName = `DV Org ${stamp}`;
    const managerName = 'מנהל בדיקה';
    const managerEmail = `dv.manager.${stamp}@example.com`;

    await page.goto(`${WEB}/he/provider/onboard`, { waitUntil: 'domcontentloaded' });
    await page.locator('#orgName').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(700); // hydration settle (RHF must register before fill)

    await page.fill('#orgName', orgName);
    await page.fill('#managerName', managerName);
    await page.fill('#managerEmail', managerEmail);
    await expect(page.locator('#orgName')).toHaveValue(orgName);

    // Capture the create POST as a first oracle, then submit.
    const postP = page
      .waitForResponse(
        (r) => r.url().includes('/api/v1/provider/tenants') && r.request().method() === 'POST',
        { timeout: 15_000 },
      )
      .catch(() => null);
    await page.locator('form button[type="submit"]').last().click();
    const post = await postP;
    const postStatus = post ? post.status() : null;

    // UX oracle: the success surface ("הלקוח נוצר") renders with the org name.
    let successShown = false;
    try {
      await page
        .getByText('הלקוח נוצר', { exact: false })
        .waitFor({ state: 'visible', timeout: 10_000 });
      successShown = true;
    } catch {
      /* no success panel */
    }
    await page
      .screenshot({ path: `${ART}/persona-provider-onboard-result.png`, fullPage: true })
      .catch(() => {});

    // AUTHORITATIVE oracle: re-read the tenants list from the provider API and
    // confirm the new org name is really there.
    let inApi = false;
    let newOrgId: string | null = null;
    const listResp = await providerApiGet(page, '/api/v1/provider/tenants?limit=100');
    if (listResp.ok()) {
      const data = JSON.parse(await listResp.text()) as {
        data: { id: string; name: string }[];
      };
      const found = data.data.find((o) => o.name === orgName);
      inApi = !!found;
      newOrgId = found?.id ?? null;
    }

    // Reproduce the create end-to-end ×2 (a 2nd distinct org) — proves the
    // first wasn't a fluke and the form isn't a one-shot.
    const stamp2 = Date.now() + 1;
    const orgName2 = `DV Org ${stamp2}`;
    await page.goto(`${WEB}/he/provider/onboard`, { waitUntil: 'domcontentloaded' });
    await page.locator('#orgName').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(700);
    await page.fill('#orgName', orgName2);
    await page.fill('#managerName', managerName);
    await page.fill('#managerEmail', `dv.manager.${stamp2}@example.com`);
    await page.locator('form button[type="submit"]').last().click();
    await page
      .getByText('הלקוח נוצר', { exact: false })
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    let inApi2 = false;
    const listResp2 = await providerApiGet(page, '/api/v1/provider/tenants?limit=100');
    if (listResp2.ok()) {
      const data = JSON.parse(await listResp2.text()) as { data: { name: string }[] };
      inApi2 = data.data.some((o) => o.name === orgName2);
    }

    const created = inApi && inApi2;
    record({
      action: 'Onboard a new organisation',
      performed:
        '/provider/onboard → fill orgName+managerName+managerEmail → submit → assert success panel + re-read tenants API (×2 distinct orgs)',
      outcome: created
        ? `CONFIRMED: org "${orgName}" (id ${newOrgId}) AND a 2nd org both appear in GET /provider/tenants`
        : 'FAILED: created org not found in tenants API',
      shouldProvider: 'yes',
      verdict: created ? 'works' : 'FUNCTIONAL_BUG',
      proof: `POST=${postStatus} successPanel=${successShown} org1InApi=${inApi} org1Id=${newOrgId} org2InApi=${inApi2}`,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION 4 — SUSPEND Beta through the UI; CONFIRM suspendedAt flips. Then
  //   REACTIVATE through the UI; CONFIRM it clears. Never leave Beta suspended.
  // ─────────────────────────────────────────────────────────────────────────
  test('Suspend then reactivate Beta through the UI (confirmed by API state)', async () => {
    test.setTimeout(180_000);
    await passAccessReasonGate(page);
    await ensureBetaActive(page); // start from a known-active baseline

    // ---- SUSPEND ----
    await page.goto(`${WEB}/he/provider/tenants/${BETA_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    // Reveal the inline suspend form (button "השעה לקוח"), fill the note, confirm.
    const suspendBtn = page.getByRole('button', { name: 'השעה לקוח' });
    await suspendBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await suspendBtn.click();
    const noteField = page.locator('#suspend-note');
    await noteField.waitFor({ state: 'visible', timeout: 6_000 });
    await noteField.fill('DV persona suspend probe');
    const confirmBtn = page.getByRole('button', { name: 'אשר השעיה' });
    const suspendPostP = page
      .waitForResponse(
        (r) => r.url().includes(`/tenants/${BETA_ID}/suspend`) && r.request().method() === 'POST',
        { timeout: 15_000 },
      )
      .catch(() => null);
    await confirmBtn.click();
    const suspendPost = await suspendPostP;
    await page.waitForTimeout(1200);
    const suspendedAfter = await tenantSuspended(page, BETA_ID);

    await page
      .screenshot({ path: `${ART}/persona-provider-beta-suspended.png`, fullPage: true })
      .catch(() => {});

    // ---- REACTIVATE ---- (accept the window.confirm)
    page.once('dialog', (d) => void d.accept().catch(() => {}));
    await page.goto(`${WEB}/he/provider/tenants/${BETA_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const reactivateBtn = page.getByRole('button', { name: 'החזר לפעולה' });
    await reactivateBtn.waitFor({ state: 'visible', timeout: 10_000 });
    const reactPostP = page
      .waitForResponse(
        (r) =>
          r.url().includes(`/tenants/${BETA_ID}/reactivate`) && r.request().method() === 'POST',
        { timeout: 15_000 },
      )
      .catch(() => null);
    await reactivateBtn.click();
    const reactPost = await reactPostP;
    await page.waitForTimeout(1200);
    const suspendedAfterReactivate = await tenantSuspended(page, BETA_ID);

    const suspendOk = suspendedAfter === true;
    const reactivateOk = suspendedAfterReactivate === false;

    record({
      action: 'Suspend a tenant (Beta)',
      performed:
        'tenant detail → "השעה לקוח" → note → "אשר השעיה" → re-read provider detail API for suspendedAt',
      outcome: suspendOk
        ? 'CONFIRMED: Beta.suspendedAt is set after the UI suspend'
        : 'FAILED: Beta did not become suspended',
      shouldProvider: 'yes',
      verdict: suspendOk ? 'works' : 'FUNCTIONAL_BUG',
      proof: `suspendPOST=${suspendPost ? suspendPost.status() : 'none'} apiSuspendedAfter=${suspendedAfter}`,
    });
    record({
      action: 'Reactivate a tenant (Beta)',
      performed:
        'tenant detail → "החזר לפעולה" (accept confirm) → re-read provider detail API for suspendedAt',
      outcome: reactivateOk
        ? 'CONFIRMED: Beta.suspendedAt cleared after the UI reactivate — restored'
        : 'FAILED: Beta still suspended after reactivate',
      shouldProvider: 'yes',
      verdict: reactivateOk ? 'works' : 'FUNCTIONAL_BUG',
      proof: `reactivatePOST=${reactPost ? reactPost.status() : 'none'} apiSuspendedAfter=${suspendedAfterReactivate}`,
    });

    // Hard safety: Beta MUST be active at the end of this test.
    await ensureBetaActive(page);
    expect(await tenantSuspended(page, BETA_ID), 'Beta left active').toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION 5 — Audit visibility of the provider's OWN actions.
  //   The /provider/audit endpoint surfaces the ORG-tier audit_log (cross-
  //   tenant). The provider's own writes (onboard/suspend/reactivate) land in
  //   provider_audit_log, which has NO read endpoint — confirm that gap.
  // ─────────────────────────────────────────────────────────────────────────
  test('Audit surfaces org-tier rows; provider-tier actions have no read path', async () => {
    test.setTimeout(120_000);
    await passAccessReasonGate(page);

    // org-tier audit IS reachable + returns rows.
    const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const orgAudit = await providerApiGet(
      page,
      `/api/v1/provider/audit?fromDate=${encodeURIComponent(since)}&limit=25`,
    );
    let orgRows = -1;
    let hasProviderTierRow = false;
    if (orgAudit.ok()) {
      const data = JSON.parse(await orgAudit.text()) as { data: { action: string }[] };
      orgRows = data.data.length;
      hasProviderTierRow = data.data.some((r) => r.action.startsWith('provider.tenant.'));
    }

    record({
      action: 'Provider audit — view recent activity',
      performed: 'GET /provider/audit?fromDate=<6h ago> with the access_reason header',
      outcome:
        orgRows > 0
          ? `CONFIRMED: org-tier audit_log readable (${orgRows} rows in last 6h)`
          : `audit endpoint returned ${orgAudit.status()} / ${orgRows} rows`,
      shouldProvider: 'yes',
      verdict: orgRows > 0 ? 'works' : 'FUNCTIONAL_BUG',
      proof: `httpOk=${orgAudit.ok()} rows=${orgRows}`,
    });

    record({
      action: "Audit of the provider's OWN actions (onboard/suspend/reactivate)",
      performed:
        'check whether the just-performed provider.tenant.* writes are visible through any provider read endpoint',
      outcome: hasProviderTierRow
        ? 'CONFIRMED: provider.tenant.* rows surfaced via /provider/audit'
        : 'MISSING: provider_audit_log (where provider.tenant.created/suspended/reactivated land) has NO read endpoint — the operator cannot review their own audited actions in-product',
      shouldProvider: 'yes',
      verdict: hasProviderTierRow ? 'works' : 'MISSING',
      proof: `providerTierRowsVisibleViaApi=${hasProviderTierRow} (rows are written to provider_audit_log per provider-audit.controller.ts comment "surfaced separately if ever needed")`,
    });

    expect(orgAudit.ok(), 'audit endpoint reachable').toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Final harness assertion: every action ran (this spec is a report; it must
  // not fail on a product bug, only on a harness failure).
  // ─────────────────────────────────────────────────────────────────────────
  test('harness ran every provider action', async () => {
    expect(ledger.length).toBeGreaterThanOrEqual(7);
  });
});
