import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import { WEB, API } from './_helpers';

/**
 * V13 ACCEPTANCE — Provider tier (cross-tenant, MFA) coverage on the REAL
 * stack. Logs in via the genuine provider auth contract (email + password +
 * the dev MFA bypass code 000000, active when DEV_AUTH_BYPASS=1) so the
 * httpOnly provider session lands in the page context, then walks every
 * /provider route capturing the owner's 6 axes + a screenshot.
 *
 * Prereq: a provider_users row exists — bootstrap once via
 *   DB_TARGET=local LOCAL_DATABASE_URL=... BOOTSTRAP_ADMIN_EMAIL=provider@emapp.dev
 *   BOOTSTRAP_ADMIN_PASSWORD=ProviderPass123! BOOTSTRAP_ADMIN_NAME='...'
 *   infisical run --env dev -- pnpm --filter @emapp/db exec tsx scripts/bootstrap-provider-admin.ts
 */
const ART = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'provider-coverage');
mkdirSync(ART, { recursive: true });
const HMR = /Connection closed|WebSocket|ResizeObserver|HMR|Hot Module|favicon|No link element found|Download the React/i;

const ROUTES = [
  { path: '/he/provider', label: 'provider-home' },
  { path: '/he/provider/tenants', label: 'tenants-list' },
  { path: '/he/provider/audit', label: 'audit' },
  { path: '/he/provider/audit/self', label: 'audit-self' },
  { path: '/he/provider/backups', label: 'backups' },
  { path: '/he/provider/onboard', label: 'onboard' },
  { path: '/he/provider/system-health', label: 'system-health' },
];

const PROVIDER = { email: 'provider@emapp.dev', password: 'ProviderPass123!', mfa_code: '000000' };

test('provider tier — login (email+pw+MFA bypass) then walk all /provider routes', async ({ page }) => {
  const findings: Record<string, unknown>[] = [];

  // ── Real provider auth: email + password + dev MFA bypass code ──
  const login = await page.context().request.post(`${API}/api/v1/provider/auth/login`, {
    data: PROVIDER,
    headers: { 'Content-Type': 'application/json' },
  });
  const loginStatus = login.status();
  writeFileSync(join(ART, '_login.json'), JSON.stringify({ loginStatus, body: await login.json().catch(() => null) }, null, 2));
  expect(loginStatus, 'provider login (email+pw+MFA bypass) must succeed').toBe(200);

  for (const r of ROUTES) {
    const consoleErrors: string[] = [];
    const failedNetwork: string[] = [];
    const onConsole = (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !HMR.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
    };
    const onPageErr = (e: Error) => { if (!HMR.test(e.message)) consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`); };
    const onResp = (resp: { url: () => string; status: () => number }) => {
      const u = resp.url();
      if (resp.status() >= 400 && (u.includes('/api/v1') || u.startsWith(WEB)) && !u.includes('/_next/static'))
        failedNetwork.push(`${resp.status()} ${u.replace(WEB, '').replace(API, '')}`);
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageErr);
    page.on('response', onResp);

    await page.goto(`${WEB}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(1000);
    // WARM interaction time — owner's < 1s budget (feedback_sub_second_interaction_budget).
    const warmStart = Date.now();
    await page.goto(`${WEB}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const warmMs = Date.now() - warmStart;
    await page.waitForTimeout(500);
    if (warmMs > 1000) console.log(`[PERF>1s] provider/${r.label} warm load = ${warmMs}ms`);
    const url = page.url();
    const bounced = url.includes('/login');
    const errorBoundary = await page.getByText(/משהו השתבש|אירעה שגיאה|Something went wrong/).count().then((n) => n > 0).catch(() => false);
    const lowContrast = await page.evaluate(() => {
      const out: string[] = [];
      const parse = (c: string) => (c.match(/\d+/g) || []).map(Number);
      const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
      for (const el of Array.from(document.querySelectorAll('main *')).slice(0, 3000)) {
        const h = el as HTMLElement;
        const txt = h.innerText?.trim();
        if (!txt || txt.length < 2 || h.childElementCount > 0) continue;
        const s = getComputedStyle(el);
        const [r, g, b] = parse(s.color);
        let bg = s.backgroundColor; let alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : 1; let overImage = s.backgroundImage !== 'none'; let p: Element | null = el;
        while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || alpha < 0.95) && p?.parentElement) { p = p.parentElement; const cs = getComputedStyle(p); if (cs.backgroundImage !== 'none') overImage = true; bg = cs.backgroundColor; alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3] ?? '1') : 1; }
        if (overImage) continue;
        const [br, bgc, bb] = parse(bg);
        if ([r, g, b, br, bgc, bb].some((x) => x === undefined)) continue;
        if (lum(br, bgc, bb) > 205 && Math.abs(lum(r, g, b) - lum(br, bgc, bb)) < 38) out.push(`"${txt.slice(0, 24)}" ${s.color} on ${bg}`);
      }
      return Array.from(new Set(out)).slice(0, 12);
    }).catch(() => [] as string[]);
    await page.screenshot({ path: join(ART, `${r.label}.png`) }).catch(() => {});
    findings.push({ route: r.label, url, bounced, errorBoundary, consoleErrors, failedNetwork, lowContrast, warmMs });

    page.off('console', onConsole);
    page.off('pageerror', onPageErr);
    page.off('response', onResp);

    expect(bounced, `provider ${r.label} must not bounce to /login`).toBeFalsy();
    expect(errorBoundary, `provider ${r.label} no error boundary`).toBeFalsy();
    expect(consoleErrors, `provider ${r.label} clean console`).toEqual([]);
    expect(failedNetwork, `provider ${r.label} no failed network`).toEqual([]);
    // lowContrast ADVISORY (gradient-hero false-positives) — palette guard is the gate.
    if (lowContrast.length) console.log(`[advisory] provider/${r.label} contrast hits:`, lowContrast.length);
  }

  writeFileSync(join(ART, '_summary.json'), JSON.stringify(findings, null, 2));
});
