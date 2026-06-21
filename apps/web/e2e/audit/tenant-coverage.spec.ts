import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import { WEB, API } from './_helpers';

/**
 * V13 ACCEPTANCE — Tenant tier (SMS OTP, own record) coverage on the REAL
 * stack. Drives the genuine two-step OTP flow (request → verify with the dev
 * bypass code 000000) to land a real tenant session, then walks /portal.
 * Prereq: otp_codes cleared for this phone (rate-limit reset) — see _otp-clear.ts.
 */
const ART = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'tenant-coverage');
mkdirSync(ART, { recursive: true });
const HMR = /Connection closed|WebSocket|ResizeObserver|HMR|Hot Module|favicon|No link element found|Download the React/i;
const TENANT = { phone: '0501234567', orgSlug: 'alpha-dev' };

test('tenant tier — OTP login (bypass 000000) then walk /portal', async ({ page }) => {
  const req = await page.context().request.post(`${API}/api/v1/auth/otp/request`, {
    data: { phone: TENANT.phone, orgSlug: TENANT.orgSlug }, headers: { 'Content-Type': 'application/json' },
  });
  const verify = await page.context().request.post(`${API}/api/v1/auth/otp/verify`, {
    data: { phone: TENANT.phone, orgSlug: TENANT.orgSlug, code: '000000' }, headers: { 'Content-Type': 'application/json' },
  });
  const verifyStatus = verify.status();
  writeFileSync(join(ART, '_login.json'), JSON.stringify({ requestStatus: req.status(), verifyStatus, body: await verify.json().catch(() => null) }, null, 2));
  expect(verifyStatus, 'tenant OTP verify (bypass 000000) must succeed').toBe(200);

  const consoleErrors: string[] = [];
  const failedNetwork: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !HMR.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => { if (!HMR.test(e.message)) consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`); });
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && (u.includes('/api/v1') || u.startsWith(WEB)) && !u.includes('/_next/static'))
      failedNetwork.push(`${r.status()} ${u.replace(WEB, '').replace(API, '')}`);
  });

  await page.goto(`${WEB}/he/portal`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // WARM interaction time — owner's < 1s budget (feedback_sub_second_interaction_budget).
  const warmStart = Date.now();
  await page.goto(`${WEB}/he/portal`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  const warmMs = Date.now() - warmStart;
  await page.waitForTimeout(600);
  if (warmMs > 1000) console.log(`[PERF>1s] tenant/portal warm load = ${warmMs}ms`);

  const url = page.url();
  const bounced = url.includes('/login');
  const errorBoundary = await page.getByText(/משהו השתבש|אירעה שגיאה|Something went wrong/).count().then((n) => n > 0).catch(() => false);
  const portalText = await page.locator('body').innerText().catch(() => '');
  const nationalIdLeak = /\b\d{9}\b/.test(portalText) && !/•/.test(portalText.match(/\b\d{9}\b/)?.[0] ?? '');
  const lowContrast = await page.evaluate(() => {
    const out: string[] = [];
    const parse = (c: string) => (c.match(/\d+/g) || []).map(Number);
    const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
    for (const el of Array.from(document.querySelectorAll('main *')).slice(0, 3000)) {
      const h = el as HTMLElement; const txt = h.innerText?.trim();
      if (!txt || txt.length < 2 || h.childElementCount > 0) continue;
      const s = getComputedStyle(el); const [r, g, b] = parse(s.color);
      let bg = s.backgroundColor; let alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : 1; let overImage = s.backgroundImage !== 'none'; let p: Element | null = el;
      while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || alpha < 0.95) && p?.parentElement) {
        p = p.parentElement; const cs = getComputedStyle(p); if (cs.backgroundImage !== 'none') overImage = true; bg = cs.backgroundColor; alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3] ?? '1') : 1;
      }
      if (overImage) continue;
      const [br, bgc, bb] = parse(bg);
      if ([r, g, b, br, bgc, bb].some((x) => x === undefined)) continue;
      if (lum(br, bgc, bb) > 205 && Math.abs(lum(r, g, b) - lum(br, bgc, bb)) < 38) out.push(`"${txt.slice(0, 24)}" ${s.color} on ${bg}`);
    }
    return Array.from(new Set(out)).slice(0, 12);
  }).catch(() => [] as string[]);

  await page.screenshot({ path: join(ART, 'portal.png'), fullPage: true }).catch(() => {});
  writeFileSync(join(ART, '_summary.json'), JSON.stringify({ url, bounced, errorBoundary, consoleErrors, failedNetwork, lowContrast, nationalIdLeak, warmMs, portalText: portalText.slice(0, 800) }, null, 2));

  expect(bounced, 'tenant portal must not bounce to /login').toBeFalsy();
  expect(errorBoundary, 'tenant portal no error boundary').toBeFalsy();
  expect(consoleErrors, 'tenant portal clean console').toEqual([]);
  expect(failedNetwork, 'tenant portal no failed network').toEqual([]);
  expect(nationalIdLeak, 'tenant portal must not leak cleartext national_id').toBeFalsy();
  // lowContrast ADVISORY (navy-hero gradient false-positives) — palette guard is the gate.
  if (lowContrast.length) console.log('[advisory] tenant portal contrast hits:', lowContrast.length);
});
