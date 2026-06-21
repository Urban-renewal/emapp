/**
 * EMAPP performance-audit harness — Phase 1 (measure).
 *
 * Walks the action inventory (docs/PERF-AUDIT-INVENTORY.md) in REAL Chromium
 * against the running LOCAL stack (web :3001 → API :3000 → DB_TARGET=local), so
 * the numbers are the client's actual experience — not curl-in-isolation, not
 * remote Neon.
 *
 * Per action it records:
 *   - COLD: first hit (includes one-time Next.js dev compile — labeled artifact).
 *   - WARM: median of N re-navigations (the real steady-state number).
 *   - WATERFALL: every /api/v1 call during a warm hit + its duration (the WHY).
 *   - console errors.
 *
 * Output: docs/PERF-AUDIT-RESULTS.json (machine) + a console summary.
 *
 * Run (stack must already be up on local):
 *   pnpm --filter @emapp/web exec node perf-audit/run.mjs
 *   HEADED=1 ... to watch it in a visible Chrome window.
 */
import { writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const BASE = process.env.PERF_BASE_URL ?? 'http://localhost:3001';
const LOCALE = 'he';
const WARM_SAMPLES = Number(process.env.PERF_WARM_SAMPLES ?? 3);
const NAV_TIMEOUT = 60_000;

const CREDS = { email: 'manager@alpha.dev', password: 'DevPassword123!' };

/** Top-level manager-surface page loads (no id needed). The detail pages are
 *  appended at runtime once an id is discovered from each list endpoint. */
const STATIC_ROUTES = [
  ['dashboard home', `/${LOCALE}`],
  ['projects list', `/${LOCALE}/projects`],
  ['owners list', `/${LOCALE}/owners`],
  ['documents list', `/${LOCALE}/documents`],
  ['messages', `/${LOCALE}/messages`],
  ['buildings list', `/${LOCALE}/buildings`],
  ['apartments list', `/${LOCALE}/apartments`],
  ['signature-requests list', `/${LOCALE}/signature-requests`],
  ['imports list', `/${LOCALE}/imports`],
  ['members list', `/${LOCALE}/members`],
  ['tasks list', `/${LOCALE}/tasks`],
  ['notes list', `/${LOCALE}/notes`],
  ['notifications list', `/${LOCALE}/notifications`],
  ['audit log', `/${LOCALE}/audit`],
  ['contractors list', `/${LOCALE}/contractors`],
  ['settings', `/${LOCALE}/settings`],
  ['settings/roles', `/${LOCALE}/settings/roles`],
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

async function firstId(page, listPath) {
  // Pull the first row's id from a list endpoint (via the in-page fetch so it
  // uses the session cookie + the real proxy path).
  try {
    return await page.evaluate(async (p) => {
      const r = await fetch(p, { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      const arr = j?.data;
      const first = Array.isArray(arr) ? arr[0] : null;
      return first?.id ?? null;
    }, listPath);
  } catch {
    return null;
  }
}

/**
 * Navigate + measure TIME-TO-CONTENT (≈ what the user perceives), NOT
 * networkidle (which adds a 500ms quiet wait + blocks forever on polling
 * pages). Returns { ms, ttfbMs, apiCalls, consoleErrors }.
 *   - ms     : nav start → main content rendered (text in <main>).
 *   - apiCalls: per /api/v1 call duration from the in-page Resource Timing API
 *              (the reliable source; Playwright's response.timing() returned null).
 */
async function measureNav(page, url, collectWaterfall) {
  const consoleErrors = [];
  const onConsole = (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 140));
  };
  if (collectWaterfall) page.on('console', onConsole);

  const t0 = Date.now();
  // clear resource timings so the waterfall is THIS navigation only.
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  // wait for the page's real content to render (the dashboard shell + the
  // route's <main> body). Cap at NAV_TIMEOUT; polling pages still resolve here
  // because we don't wait for the network to go quiet.
  await page
    .waitForFunction(() => (document.querySelector('main')?.innerText ?? '').length > 80, null, {
      timeout: NAV_TIMEOUT,
    })
    .catch(() => {});
  const ms = Date.now() - t0;

  let apiCalls = [];
  if (collectWaterfall) {
    apiCalls = await page
      .evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter((e) => e.name.includes('/api/v1/'))
          .map((e) => ({
            url: e.name.replace(location.origin, '').split('?')[0].slice(0, 48),
            ms: Math.round(e.duration),
            startMs: Math.round(e.startTime),
          })),
      )
      .catch(() => []);
    page.off('console', onConsole);
  }
  return { ms, apiCalls, consoleErrors };
}

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  const results = [];

  // ── LOGIN (measured, real form path) ──────────────────────────────────────
  await page.goto(`${BASE}/${LOCALE}/login`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  // warm the login route compile, then measure a clean submit→dashboard.
  await page.fill('input[type=email], input[name=email]', CREDS.email);
  await page.fill('input[type=password], input[name=password]', CREDS.password);
  const tLogin = Date.now();
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: NAV_TIMEOUT }),
    page.click('button[type=submit]'),
  ]);
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
  results.push({ action: 'LOGIN submit→dashboard', coldMs: Date.now() - tLogin, warmMs: null });

  // ── discover detail ids (so detail pages are measurable) ──────────────────
  const projectId = await firstId(page, '/api/v1/projects?limit=1');
  const ownerId = await firstId(page, '/api/v1/owners?limit=1');
  const documentId = await firstId(page, '/api/v1/documents?limit=1');
  const routes = [...STATIC_ROUTES];
  if (projectId) routes.push(['project detail', `/${LOCALE}/projects/${projectId}`]);
  if (ownerId) routes.push(['owner detail', `/${LOCALE}/owners/${ownerId}`]);
  if (documentId) routes.push(['document detail', `/${LOCALE}/documents/${documentId}`]);

  // ── per route: COLD then WARM×N + waterfall on the last warm hit ──────────
  for (const [name, url] of routes) {
    try {
      const cold = await measureNav(page, url, false);
      const warmTimes = [];
      let lastWarm = null;
      for (let i = 0; i < WARM_SAMPLES; i++) {
        lastWarm = await measureNav(page, url, i === WARM_SAMPLES - 1);
        warmTimes.push(lastWarm.ms);
      }
      results.push({
        action: name,
        url,
        coldMs: cold.ms,
        warmMs: median(warmTimes),
        warmSamples: warmTimes,
        apiCalls: lastWarm.apiCalls,
        apiCount: lastWarm.apiCalls.length,
        slowestApi: lastWarm.apiCalls.reduce(
          (a, c) => (c.ms != null && c.ms > (a?.ms ?? -1) ? c : a),
          null,
        ),
        consoleErrors: lastWarm.consoleErrors,
        verdict: median(warmTimes) <= 1000 ? 'PASS' : 'SLOW',
      });
      process.stdout.write(
        `  ${name.padEnd(28)} cold=${String(cold.ms).padStart(5)}ms  warm=${String(median(warmTimes)).padStart(5)}ms  api=${lastWarm.apiCalls.length}  ${median(warmTimes) <= 1000 ? 'PASS' : 'SLOW'}\n`,
      );
    } catch (e) {
      results.push({ action: name, url, error: String(e).slice(0, 120) });
      process.stdout.write(`  ${name.padEnd(28)} ERROR ${String(e).slice(0, 80)}\n`);
    }
  }

  await browser.close();

  const out = {
    base: BASE,
    when: process.env.PERF_STAMP ?? 'unstamped',
    warmSamples: WARM_SAMPLES,
    results,
  };
  writeFileSync(new URL('../../../docs/PERF-AUDIT-RESULTS.json', import.meta.url), JSON.stringify(out, null, 2));
  const slow = results.filter((r) => r.verdict === 'SLOW');
  process.stdout.write(`\nDONE. ${results.length} actions measured, ${slow.length} SLOW (>1s warm).\n`);
  process.stdout.write(`Results → docs/PERF-AUDIT-RESULTS.json\n`);
}

main().catch((e) => {
  process.stderr.write(`perf-audit failed: ${String(e)}\n`);
  process.exit(1);
});
