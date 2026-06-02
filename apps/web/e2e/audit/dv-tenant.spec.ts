import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { test, expect, observe, WEB } from './_helpers';

/**
 * DV — Interface 3 (Resident / tenant portal). ONE OTP login, then walk the
 * single-page portal and exercise the resident's own-data surfaces. Read-only
 * coverage: screenshot + network (with response BODIES) + console + oracle
 * assertions.
 *
 * THE HEADLINE SECURITY ASSERTION (DV-PLAN resident SCOPE rule): the resident
 * must see ONLY their own data + project progress as an AGGREGATE (%, counts) —
 * NEVER another resident's name / national_id / phone / individual record. Own
 * PII must be MASKED (D.47 — `•••`). This spec scans the portal DOM text AND
 * every `/api/v1/portal/*` response body for: any owner name other than the
 * logged-in resident's, any cleartext `national_id`/`nationalId`, any unmasked
 * phone, any per-resident breakdown. A hit → CRITICAL finding (DV-TEN, HIGH).
 *
 * Artifacts → docs/DV/results/artifacts/tenant-<slug>.png
 * Evidence rollup → docs/DV/results/artifacts/tenant-evidence.json
 *
 * Seed:demo oracle (phone 0501234567, dev OTP 000000), derived 2026-06-02 from
 * the live portal API (tenant cookie). The resident is `דנה כהן`
 * (owner 86ea1064-…, org Alpha f4c183e2-…):
 *   /portal/me        → name "דנה כהן", nationalIdMasked "•••••••10",
 *                       phoneMasked "•••••4567", email dana@example.dev (own)
 *   /portal/apartment → 2 apartments (own only): pct 100 + 60, project
 *                       "Tama 38/2 — Pilot", building "הרצל 10"
 *   /portal/documents → 2 own agreement docs (דירה 1/2)
 *   /portal/signatures→ 2 (1 pending, 1 signed) — own only
 *   /portal/progress  → AGGREGATE: signed 2 / pending 2 / total 4, project
 *                       "Tama 38/2 — Pilot" (counts only, no resident identities)
 *
 * The logged-in resident's OWN name ("דנה כהן") legitimately appears — the leak
 * scan whitelists it. Any OTHER seeded owner name appearing in the portal is the
 * leak we hunt. Seeded sibling owner names (from the org seed, NOT דנה) used as
 * negative oracles: "ישראל ישראלי", "אברהם לוי", "שרה מזרחי" — none must appear.
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';
fs.mkdirSync(ART, { recursive: true });

// Tenant login (setup only — DV-PLAN §2, NOT under test).
const TENANT_PHONE = '0501234567';
const TENANT_OTP = '000000';

// Oracle — the logged-in resident.
const SELF_NAME = 'דנה כהן';
const SELF_NID_MASKED = '•••••••10';
const SELF_PHONE_MASKED = '•••••4567';

// Negative oracle — OTHER seeded owner names that must NEVER surface in the
// resident portal (own-data-only). Drawn from the org seed roster.
const FOREIGN_OWNER_NAMES = ['ישראל ישראלי', 'אברהם לוי', 'שרה מזרחי', 'יוסי כהן'];

// Leak signatures: cleartext PII patterns that must NOT appear in any wire body
// or in the DOM. A cleartext Israeli national_id is 9 digits; an unmasked
// mobile phone is 05X-XXXXXXX. We also flag the literal JSON keys for cleartext
// PII (the wire should expose ONLY the masked variants).
const CLEARTEXT_NID_RE = /(?<!\d)\d{9}(?!\d)/; // 9 consecutive digits
const CLEARTEXT_PHONE_RE = /\b05\d[-\s]?\d{7}\b/; // 05X-XXXXXXX unmasked
const CLEARTEXT_PII_KEY_RE = /"(national_?id|nationalId|phone|nationalIdEnc)"\s*:/i;

interface CapturedResponse {
  url: string;
  status: number;
  ms: number;
  bodyPreview: string; // first ~4000 chars of body text
}

interface LeakHit {
  source: 'dom' | 'wire';
  kind: string;
  detail: string;
  where: string;
}

interface PageReport {
  slug: string;
  url: string;
  finalUrl: string;
  httpStatusOfDoc: number | null;
  apiCalls: { url: string; status: number; ms: number }[];
  portalBodies: CapturedResponse[]; // /api/v1/portal/* response bodies
  consoleErrors: string[];
  pageErrors: string[];
  failed4xx5xx: { url: string; status: number }[];
  bodyText: string; // trimmed first ~4000 chars
  formCount: number;
  formsWithoutPost: number;
  formMethods: string[];
  leaks: LeakHit[];
}

const reports: PageReport[] = [];

function writeRollup(): void {
  fs.writeFileSync(
    path.join(ART, 'tenant-evidence.json'),
    JSON.stringify(reports, null, 2),
    'utf8',
  );
}

/**
 * Real OTP login through the tenant form so the httpOnly `tenant_access_token`
 * cookie lands exactly as a resident gets it. Two-step: phone → code. The dev
 * bypass `000000` is accepted when DEV_AUTH_BYPASS=1. Mirrors loginAs's
 * hydration-race handling (fill, assert, click, retry once).
 */
async function tenantLogin(page: Page): Promise<void> {
  await page.goto(`${WEB}/he/tenant/login`, { waitUntil: 'networkidle' });

  // Step 1 — phone. The send button is the form's submit.
  const phoneInput = page.locator('#t-phone');
  await phoneInput.waitFor({ state: 'visible' });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await phoneInput.fill('');
    await phoneInput.fill(TENANT_PHONE);
    await expect(phoneInput).toHaveValue(TENANT_PHONE);
    await page.locator('form button[type=submit]').click();
    // Step-2 code input appears once the OTP request returns 200.
    const codeShown = await page
      .locator('#t-code')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (codeShown) break;
    if (attempt === 2) throw new Error('tenant OTP step-1 never advanced to code entry');
    await page.waitForTimeout(1500);
  }

  // Step 2 — code. Filling 6 digits auto-submits (requestSubmit on the 6th
  // digit). We must NOT also click verify — a second submit re-sends the
  // now-consumed single-use OTP and burns an attempt. We watch the verify
  // network response to know the outcome deterministically, then wait for the
  // client-side push('/portal'). Retry the WHOLE code entry once if verify
  // didn't 200 (e.g. a stale code), re-requesting a fresh OTP first.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const verifyResp = page
      .waitForResponse(
        (r) => r.url().includes('/auth/otp/verify') && r.request().method() === 'POST',
        { timeout: 15_000 },
      )
      .catch(() => null);
    const codeInput = page.locator('#t-code');
    await codeInput.fill('');
    await codeInput.fill(TENANT_OTP); // 6th digit triggers requestSubmit()
    await expect(codeInput).toHaveValue(TENANT_OTP);
    const resp = await verifyResp;
    if (resp && resp.status() === 200) {
      // Client-side router.push('/portal') — wait for the URL, not a load event.
      await page.waitForURL((u) => u.pathname.includes('/portal'), { timeout: 15_000 });
      return;
    }
    if (attempt === 2) {
      throw new Error(`tenant OTP verify failed (status ${resp ? resp.status() : 'no-response'})`);
    }
    // Re-arm: request a fresh OTP, then re-enter the code.
    await page
      .locator('button', { hasText: /קוד|resend|שלח/i })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(1500);
  }
}

/**
 * Scan a blob of text (DOM innerText or a wire body) for leak signatures.
 * Returns the hits. The resident's OWN masked PII and OWN name are whitelisted.
 */
function scanForLeaks(text: string, source: 'dom' | 'wire', where: string): LeakHit[] {
  const hits: LeakHit[] = [];

  // 1. Any FOREIGN owner name present → another resident's record leaked.
  for (const foreign of FOREIGN_OWNER_NAMES) {
    if (text.includes(foreign)) {
      hits.push({ source, kind: 'foreign_owner_name', detail: foreign, where });
    }
  }

  // 2. Cleartext national_id (9 digits) anywhere. The masked form ("•••••••10")
  //    contains only 2 digits, so it can't trip this. A real 9-digit run is a
  //    cleartext national_id leak. (Guard against false positives from large
  //    byte counts by requiring it not be part of a longer digit run — handled
  //    by the lookarounds in the regex.)
  if (CLEARTEXT_NID_RE.test(text)) {
    const m = text.match(CLEARTEXT_NID_RE);
    hits.push({ source, kind: 'cleartext_national_id', detail: m?.[0] ?? '', where });
  }

  // 3. Unmasked mobile phone (05X-XXXXXXX). The masked form ("•••••4567") has
  //    only 4 trailing digits and cannot match.
  if (CLEARTEXT_PHONE_RE.test(text)) {
    const m = text.match(CLEARTEXT_PHONE_RE);
    hits.push({ source, kind: 'cleartext_phone', detail: m?.[0] ?? '', where });
  }

  // 4. (wire only) cleartext PII JSON keys — the portal wire must expose ONLY
  //    masked variants (nationalIdMasked / phoneMasked), never the raw keys.
  if (source === 'wire' && CLEARTEXT_PII_KEY_RE.test(text)) {
    const m = text.match(CLEARTEXT_PII_KEY_RE);
    hits.push({ source, kind: 'cleartext_pii_key', detail: m?.[0] ?? '', where });
  }

  return hits;
}

/**
 * Visit a portal URL, capture screenshot + network + console + every
 * /api/v1/portal/* response body, then run the leak scan over the DOM AND
 * every captured wire body. Writes the rollup incrementally.
 */
async function walk(page: Page, slug: string, urlPath: string): Promise<PageReport> {
  const o = observe(page);
  const portalBodies: CapturedResponse[] = [];
  const t0 = new Map<string, number>();
  page.on('request', (r) => t0.set(r.url(), Date.now()));
  // Capture full bodies for portal endpoints (the leak-scan target).
  const bodyHandler = async (resp: import('@playwright/test').Response): Promise<void> => {
    const url = resp.url();
    if (!url.includes('/api/v1/portal/')) return;
    const start = t0.get(url);
    const ms = start ? Date.now() - start : -1;
    let bodyPreview = '';
    try {
      bodyPreview = (await resp.text()).slice(0, 4000);
    } catch {
      bodyPreview = '(body unavailable)';
    }
    portalBodies.push({ url, status: resp.status(), ms, bodyPreview });
  };
  page.on('response', bodyHandler);

  let docStatus: number | null = null;
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${WEB}${urlPath}`;
  const resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (resp) docStatus = resp.status();
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);

  await page
    .screenshot({ path: path.join(ART, `tenant-${slug}.png`), fullPage: true })
    .catch(() => {});

  const bodyText = (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  ).slice(0, 4000);

  const forms = page.locator('form');
  const formCount = await forms.count().catch(() => 0);
  const formMethods: string[] = [];
  let formsWithoutPost = 0;
  for (let i = 0; i < formCount; i++) {
    const m =
      (await forms
        .nth(i)
        .getAttribute('method')
        .catch(() => null)) ?? '';
    formMethods.push(m || '(none)');
    const hasSubmitHandler = await forms
      .nth(i)
      .evaluate((el) => el.hasAttribute('novalidate') || (el as HTMLFormElement).onsubmit != null)
      .catch(() => false);
    if (m.toLowerCase() !== 'post' && !hasSubmitHandler) formsWithoutPost++;
  }

  // Leak scan — DOM text + every captured portal wire body.
  const leaks: LeakHit[] = [];
  leaks.push(...scanForLeaks(bodyText, 'dom', `${slug}:dom`));
  for (const b of portalBodies) {
    leaks.push(...scanForLeaks(b.bodyPreview, 'wire', b.url));
  }

  const r: PageReport = {
    slug,
    url: urlPath,
    finalUrl: new URL(page.url()).pathname,
    httpStatusOfDoc: docStatus,
    apiCalls: o.responses,
    portalBodies,
    consoleErrors: o.consoleErrors,
    pageErrors: o.pageErrors,
    failed4xx5xx: o.failed4xx5xx,
    bodyText,
    formCount,
    formsWithoutPost,
    formMethods,
    leaks,
  };
  reports.push(r);
  writeRollup();

  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('request');
  page.removeAllListeners('response');
  return r;
}

test.describe.serial('DV tenant — Interface 3 (resident portal)', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ baseURL: WEB });
    page = await context.newPage();
    await tenantLogin(page);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('walk the resident portal + scope leak-scan (own-data-only)', async () => {
    test.setTimeout(300_000);

    // The portal is a single page; we visit it (+ a reload to confirm the
    // 5 GETs re-fire and bodies are captured).
    const pages: [string, string][] = [
      ['portal', '/he/portal'],
      ['portal-reload', '/he/portal'],
    ];
    for (const [slug, urlPath] of pages) {
      await walk(page, slug, urlPath);
    }
    writeRollup();

    const portal = reports.find((r) => r.slug === 'portal')!;

    // ── Oracle: the portal rendered the resident's OWN data ──────────────
    expect(portal.httpStatusOfDoc, 'portal doc status').not.toBeNull();
    expect(portal.finalUrl, 'landed on /portal (not bounced to login)').toContain('/portal');
    expect(portal.bodyText, 'own name rendered').toContain(SELF_NAME);
    // Own PII shows MASKED (D.47) — the masked tokens are present in the DOM.
    expect(portal.bodyText, 'national_id shown masked (D.47)').toContain(SELF_NID_MASKED);
    expect(portal.bodyText, 'phone shown masked (D.47)').toContain(SELF_PHONE_MASKED);
    // Aggregate progress — counts only ("2 / 4" appears in summary copy).
    expect(portal.bodyText, 'aggregate progress total present').toMatch(/\b4\b/);

    // ── All 5 portal GETs fired and returned 200 ─────────────────────────
    const portalUrls = portal.portalBodies.map((b) => b.url);
    for (const ep of ['me', 'apartment', 'documents', 'signatures', 'progress']) {
      const hit = portal.portalBodies.find((b) => b.url.includes(`/portal/${ep}`));
      expect(hit, `/portal/${ep} was fetched (urls: ${portalUrls.join(', ')})`).toBeTruthy();
      expect(hit!.status, `/portal/${ep} status`).toBe(200);
    }

    // ── Wire-level masking oracle: /portal/me body exposes ONLY masked PII ─
    const meBody = portal.portalBodies.find((b) => b.url.includes('/portal/me'))!.bodyPreview;
    expect(meBody, 'me wire body carries masked national_id').toContain(SELF_NID_MASKED);
    expect(meBody, 'me wire body carries masked phone').toContain(SELF_PHONE_MASKED);
    // The wire must NOT expose a raw cleartext PII key.
    expect(meBody, 'me wire body exposes NO cleartext PII json key').not.toMatch(
      CLEARTEXT_PII_KEY_RE,
    );

    // ── THE HEADLINE ASSERTION: zero leaks across DOM + every wire body ──
    const allLeaks = reports.flatMap((r) => r.leaks);
    expect(
      allLeaks,
      `SCOPE LEAK — resident saw data outside own scope: ${JSON.stringify(allLeaks, null, 2)}`,
    ).toEqual([]);

    // ── Hygiene: no console / page errors on the portal ──────────────────
    expect(portal.consoleErrors, `console errors: ${portal.consoleErrors.join(' | ')}`).toEqual([]);
    expect(portal.pageErrors, `page errors: ${portal.pageErrors.join(' | ')}`).toEqual([]);
  });

  test('cross-tier isolation — org/provider routes deny the tenant cookie', async () => {
    test.setTimeout(120_000);
    // A tenant_access_token (audience emapp-tenant) must NOT unlock org or
    // provider surfaces. Each should bounce to a login OR render no org data.
    // We hit an org API directly with the tenant cookie and assert it is NOT 200.
    const probe = await page.request.get(`${WEB}/api/v1/projects`).catch(() => null);
    if (probe) {
      expect(
        probe.status(),
        `tenant cookie must NOT read org /projects (got ${probe.status()})`,
      ).not.toBe(200);
    }
    // And the org dashboard route must not render org data for a tenant.
    await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const dom = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 4000);
    await page
      .screenshot({ path: path.join(ART, 'tenant-cross-tier-projects.png'), fullPage: true })
      .catch(() => {});
    // No foreign owner names must leak even on a misdirected org route.
    for (const foreign of FOREIGN_OWNER_NAMES) {
      expect(dom, `org route leaked foreign owner ${foreign} to tenant`).not.toContain(foreign);
    }
  });

  test('logout revokes the tenant session', async () => {
    test.setTimeout(120_000);
    // POST /portal/logout (Wave 4 M-1) clears the cookie + revokes the row.
    const res = await page.request.post(`${WEB}/api/v1/portal/logout`).catch(() => null);
    if (res) {
      expect([204, 200], `logout status (${res.status()})`).toContain(res.status());
    }
    // After logout, /portal/me must no longer be readable with the (cleared)
    // session — a fresh navigation bounces off the portal.
    await page.goto(`${WEB}/he/portal`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    const meAfter = await page.request.get(`${WEB}/api/v1/portal/me`).catch(() => null);
    if (meAfter) {
      expect(meAfter.status(), `me after logout must not be 200 (${meAfter.status()})`).not.toBe(
        200,
      );
    }
  });
});
