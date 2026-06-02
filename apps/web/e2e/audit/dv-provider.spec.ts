import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Page } from '@playwright/test';

import { test, expect, observe, WEB } from './_helpers';

/**
 * DV — Interface 2 (Provider / provider_admin). ONE login + Access-Reason
 * gate pass, then walk EVERY provider page once. Read-only coverage:
 * screenshots + network + console + oracle assertions. Plus two focused
 * behavioral sub-tests:
 *   - the Access-Reason gate rejects a too-short non-ticket reason (DV-PROV);
 *   - the Suspend dialog opens on a NON-Alpha tenant (Beta) and is verified
 *     WITHOUT confirming (never leave a tenant suspended).
 *
 * Artifacts → docs/DV/results/artifacts/provider-<page>.png
 * Evidence rollup → docs/DV/results/artifacts/provider-evidence.json
 *
 * Seed:demo oracle (provider@local.dev), derived 2026-06-02 from the live
 * provider API (cookie + access_reason=INC-1001):
 *   tenants total=2 — Alpha (users 4 / projects 7 / owners 43),
 *                      Beta  (users 1 / projects 1 / owners 1)
 *   system-health: pool.app + pool.provider present, queue counts = 0
 *   audit: cross-tenant rows visible (login, owner.pii_revealed, …)
 *   access_reason enforcement: too-short non-ticket → 400 reason_required;
 *                              missing → 400 reason_required.
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';
fs.mkdirSync(ART, { recursive: true });

// Provider credentials (setup only — DV-PLAN §2, NOT under test).
const PROVIDER = { email: 'provider@local.dev', password: 'DevPassword123!', mfa: '000000' };
const ACCESS_REASON = 'INC-1001';
const STORAGE_KEY = 'emapp.provider.access_reason';

// Tenant ids harvested from GET /api/v1/provider/tenants (provider cookie).
const ALPHA_ID = 'f4c183e2-d5ef-4b81-9a47-29162d3f9626';
const BETA_ID = 'bd0acb76-a148-4e3f-a280-e250e0435ed8'; // non-Alpha — safe for the suspend-dialog probe

interface PageReport {
  slug: string;
  url: string;
  finalUrl: string;
  httpStatusOfDoc: number | null;
  apiCalls: { url: string; status: number; ms: number }[];
  consoleErrors: string[];
  pageErrors: string[];
  failed4xx5xx: { url: string; status: number }[];
  bodyText: string; // trimmed first ~4000 chars
  formCount: number;
  formsWithoutPost: number;
  formMethods: string[];
}

const reports: PageReport[] = [];

function writeRollup(): void {
  fs.writeFileSync(
    path.join(ART, 'provider-evidence.json'),
    JSON.stringify(reports, null, 2),
    'utf8',
  );
}

/**
 * Provider login through the REAL form (httpOnly cookies land exactly as a
 * user gets them). Mirrors loginAs's hydration-race handling: fill, assert
 * value, click, retry once if still on /login.
 */
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

/**
 * Pass the Access-Reason gate (D.37) by seeding the per-tab sessionStorage
 * the gate reads on mount. We assert the gate is actually present first (so
 * a regression that drops the gate is caught), then seed + reload so the
 * gate resolves to the open state with a valid reason.
 */
async function passAccessReasonGate(page: Page): Promise<void> {
  await page.goto(`${WEB}/he/provider`, { waitUntil: 'domcontentloaded' });
  // The gate form input id is `provider-reason`. Assert it blocks first.
  const reasonInput = page.locator('#provider-reason');
  await reasonInput.waitFor({ state: 'visible', timeout: 10_000 });
  // Type a valid ticket reason and submit through the real gate form.
  await reasonInput.fill(ACCESS_REASON);
  await page.locator('form button[type=submit]').click();
  // Gate gone → page content mounts. Belt-and-suspenders: also seed storage
  // so subsequent navigations (which re-read sessionStorage on mount) pass.
  await page.evaluate(([k, v]) => window.sessionStorage.setItem(k, v), [
    STORAGE_KEY,
    ACCESS_REASON,
  ] as const);
  await expect(reasonInput).toHaveCount(0, { timeout: 10_000 });
}

async function walk(page: Page, slug: string, urlPath: string): Promise<PageReport> {
  const o = observe(page);
  let docStatus: number | null = null;
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${WEB}${urlPath}`;
  const resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (resp) docStatus = resp.status();
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(400);

  await page
    .screenshot({ path: path.join(ART, `provider-${slug}.png`), fullPage: true })
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

  const r: PageReport = {
    slug,
    url: urlPath,
    finalUrl: new URL(page.url()).pathname,
    httpStatusOfDoc: docStatus,
    apiCalls: o.responses,
    consoleErrors: o.consoleErrors,
    pageErrors: o.pageErrors,
    failed4xx5xx: o.failed4xx5xx,
    bodyText,
    formCount,
    formsWithoutPost,
    formMethods,
  };
  reports.push(r);
  writeRollup(); // incremental — a timeout never loses the rollup
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('request');
  page.removeAllListeners('response');
  return r;
}

test('DV provider — walk every provider page once', async ({ page }) => {
  test.setTimeout(600_000);
  await providerLogin(page);
  await passAccessReasonGate(page);

  const pages: [string, string][] = [
    ['dashboard', '/he/provider'],
    ['tenants-list', '/he/provider/tenants'],
    ['tenant-detail-alpha', `/he/provider/tenants/${ALPHA_ID}`],
    ['tenant-detail-beta', `/he/provider/tenants/${BETA_ID}`],
    ['onboard', '/he/provider/onboard'],
    ['audit', '/he/provider/audit'],
    ['audit-org-filter', `/he/provider/audit?orgId=${ALPHA_ID}`],
    ['system-health', '/he/provider/system-health'],
  ];

  for (const [slug, urlPath] of pages) {
    await walk(page, slug, urlPath);
  }
  writeRollup();

  // Oracle: tenants list shows BOTH seed tenants.
  const tenants = reports.find((r) => r.slug === 'tenants-list')!;
  expect(tenants.bodyText, 'tenants list shows Alpha').toContain('Alpha');
  expect(tenants.bodyText, 'tenants list shows Beta').toContain('Beta');

  // Oracle: Alpha detail surfaces the seed counts (43 owners, 7 projects).
  const alpha = reports.find((r) => r.slug === 'tenant-detail-alpha')!;
  expect(alpha.bodyText, 'Alpha detail shows owner count 43').toContain('43');

  // Every walked page returned a document (no hard navigation failure) and
  // landed on a /provider/* path (gate did not bounce us back to login).
  for (const r of reports) {
    expect(r.httpStatusOfDoc, `${r.slug} doc status`).not.toBeNull();
    expect(r.finalUrl, `${r.slug} stayed in provider console`).toContain('/provider');
  }
});

test('DV provider — Access-Reason gate rejects a too-short non-ticket reason', async ({ page }) => {
  test.setTimeout(120_000);
  await providerLogin(page);
  await page.goto(`${WEB}/he/provider`, { waitUntil: 'domcontentloaded' });

  const reasonInput = page.locator('#provider-reason');
  await reasonInput.waitFor({ state: 'visible', timeout: 10_000 });

  // A too-short non-ticket reason: the submit button is disabled (the gate
  // mirrors the BE `validateProviderReason` — ticket ref OR ≥20 chars).
  await reasonInput.fill('hello');
  const submit = page.locator('form button[type=submit]');
  await expect(submit, 'short reason keeps submit disabled').toBeDisabled();
  // Gate still present (we were NOT let through).
  await expect(reasonInput, 'gate still blocks on short reason').toBeVisible();

  await page
    .screenshot({ path: path.join(ART, 'provider-gate-rejects-short.png'), fullPage: true })
    .catch(() => {});

  // A valid ticket reason flips the button enabled.
  await reasonInput.fill(ACCESS_REASON);
  await expect(submit, 'valid ticket reason enables submit').toBeEnabled();
});

test('DV provider — Suspend dialog opens on Beta (verify, never confirm)', async ({ page }) => {
  test.setTimeout(180_000);
  await providerLogin(page);
  await passAccessReasonGate(page);

  const o = observe(page);
  await page.goto(`${WEB}/he/provider/tenants/${BETA_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});

  // The suspension panel renders a single suspend trigger when active.
  // Click it to reveal the inline confirm form, then STOP — we never click
  // confirm, so Beta is never actually suspended.
  const suspendBtn = page.getByRole('button', { name: /השעיה|השעה|suspend/i }).first();
  await suspendBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await suspendBtn.click();

  // Inline confirm form (textarea + confirm button) is now present.
  const noteField = page.locator('#suspend-note');
  await expect(noteField, 'suspend confirm form revealed').toBeVisible({ timeout: 5_000 });

  await page
    .screenshot({ path: path.join(ART, 'provider-suspend-dialog.png'), fullPage: true })
    .catch(() => {});

  // Cancel out — restore the page to its inert state. Beta stays ACTIVE.
  const cancel = page.getByRole('button', { name: /ביטול|cancel/i }).first();
  await cancel.click().catch(() => {});
  await expect(noteField, 'suspend form dismissed (Beta untouched)').toHaveCount(0, {
    timeout: 5_000,
  });

  // No console errors during the dialog interaction.
  expect(
    o.consoleErrors,
    `console errors on suspend dialog: ${o.consoleErrors.join(' | ')}`,
  ).toEqual([]);
});
