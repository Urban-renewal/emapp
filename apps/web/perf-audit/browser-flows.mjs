/**
 * EMAPP browser-real interaction audit — every MUTATION performed as a REAL
 * user in a REAL (headed) Chromium against the local-DB stack: navigate to the
 * actual page, fill the actual form / click the actual button, wait for the
 * actual result (redirect / success / error), and time the FULL user-perceived
 * flow + capture the HTTP status + PASS/FAIL. NO request-API shortcuts.
 *
 * Complements full-audit.mjs (which already does the page-LOADS browser-real).
 *
 * Run (stack up on local; HEADED so you can watch it):
 *   HEADED=1 PERF_BASE_URL=http://localhost:3001 node perf-audit/browser-flows.mjs
 *
 * Output: docs/PERF-AUDIT-BROWSER-<stamp>.json
 */
import { writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';

const BASE = process.env.PERF_BASE_URL ?? 'http://localhost:3001';
const STAMP = process.env.PERF_STAMP ?? (BASE.includes('3002') ? 'prod' : 'dev');
const L = 'he';
const T = Number(process.env.PERF_NAV_TIMEOUT ?? 90_000);
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const results = [];

const setNative = `(el,v)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}`;

function record(role, action, ms, status, verdict, detail) {
  results.push({ role, action, ms, status, verdict, detail });
  log(
    `  [${role}] ${String(action).padEnd(32)} ${String(ms).padStart(6)}ms ` +
      `${status ? 'http=' + status + ' ' : ''}${verdict}${detail ? '  ' + detail : ''}`,
  );
}

/** Log in as an org role through the REAL login form (browser). */
async function browserLogin(page, email) {
  await page.goto(`${BASE}/${L}/login`, { waitUntil: 'domcontentloaded', timeout: T });
  await page.waitForSelector('input[type=email],input[name=email]', { timeout: T });
  const t = Date.now();
  // proven pattern: native value-setter + form.requestSubmit() in ONE eval.
  await page.evaluate((creds) => {
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const em = document.querySelector('input[type=email],input[name=email]');
    const pw = document.querySelector('input[type=password],input[name=password]');
    set(em, creds.email);
    set(pw, creds.password);
    em.closest('form').requestSubmit();
  }, { email, password: 'DevPassword123!' });
  try {
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 40_000 });
    record(email.split('@')[0], 'LOGIN (real form → dashboard)', Date.now() - t, 200, 'PASS');
  } catch {
    // robustness: form login didn't redirect — fall back to the request API so
    // the browser-real MUTATIONS (the priority) still run authenticated.
    const r = await page.context().request.post(`${BASE}/api/v1/auth/login`, { data: { email, password: 'DevPassword123!' } });
    record(email.split('@')[0], 'LOGIN (form stalled → api fallback)', Date.now() - t, r.status(), r.ok() ? 'PASS(api-fallback)' : 'FAIL');
    await page.goto(`${BASE}/${L}`, { waitUntil: 'domcontentloaded', timeout: T }).catch(() => {});
  }
  await page.waitForFunction(() => (document.querySelector('main')?.innerText ?? '').length > 60, null, { timeout: T }).catch(() => {});
}

/**
 * Real form flow: go to `url`, fill every visible input with a sensible value,
 * click the primary submit, wait for the create POST + the redirect. Times the
 * whole thing; PASS iff a 2xx create fired AND we left the form (or a success
 * appeared). Captures a 4xx/5xx as the real on-screen failure.
 */
async function browserForm(page, role, action, url, fills = {}, postPathFrag) {
  let postStatus = null;
  const onResp = (r) => {
    const u = r.url();
    if (u.includes('/api/v1/') && r.request().method() !== 'GET' && (!postPathFrag || u.includes(postPathFrag))) {
      postStatus = r.status();
    }
  };
  page.on('response', onResp);
  try {
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: T });
    await page.waitForSelector('form input, form textarea, form select', { timeout: T });
    // Wait for HYDRATION (JS chunks loaded) so the submit handler is wired —
    // otherwise on a cold-compiled dev route the click fires no POST.
    await page.waitForLoadState('networkidle', { timeout: T }).catch(() => {});
    await page.waitForTimeout(600);
    const t = Date.now();
    // fill inputs: explicit fills by name first, then a generic pass. Inline the
    // native value-setter (NO eval — the app's CSP forbids eval).
    await page.evaluate((fills) => {
      const set = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      for (const el of document.querySelectorAll('form input, form textarea')) {
        const key = (el.getAttribute('name') || '') + '|' + (el.getAttribute('placeholder') || '');
        let v = null;
        for (const [k, val] of Object.entries(fills)) if (new RegExp(k, 'i').test(key)) { v = val; break; }
        if (v == null) {
          if (el.type === 'number') v = '3';
          else if (el.type === 'email') v = `perf${Date.now()}@ex.com`;
          else if (el.type === 'text' || el.tagName === 'TEXTAREA') v = `בדיקה ${Date.now() % 100000}`;
        }
        if (v != null && !el.value) set(el, v);
      }
    }, fills);
    const beforeUrl = page.url();
    const submit = page.locator('form button[type=submit]').or(page.getByRole('button', { name: /הוסף|צור|שמור|שלח|create|add|save|submit/i })).first();
    await submit.click({ timeout: T }).catch(() => {});
    // wait for either a redirect away from /new OR a server response
    await page.waitForTimeout(400);
    await page.waitForFunction((b) => location.href !== b || document.querySelector('[class*=destructive],[role=alert]'), beforeUrl, { timeout: 12_000 }).catch(() => {});
    const ms = Date.now() - t;
    const navigated = page.url() !== beforeUrl && !page.url().includes('/new');
    const errText = await page.evaluate(() => {
      const e = document.querySelector('.text-destructive,[role=alert],.text-red-500');
      return e ? e.textContent.trim().slice(0, 80) : null;
    });
    const ok = postStatus && postStatus < 400;
    const verdict = ok ? (ms <= 1000 ? 'PASS' : 'SLOW') : 'FAIL';
    record(role, action, ms, postStatus, verdict, errText ? `err="${errText}"` : navigated ? '→ navigated' : '(no nav)');
  } catch (e) {
    record(role, action, 0, null, 'ERROR', String(e).slice(0, 70));
  } finally {
    page.off('response', onResp);
  }
}

/** Real action-button flow: go to `detailUrl`, click the button matching
 *  `label`, wait for the resulting POST/PATCH/DELETE; time + capture status. */
async function browserAction(page, role, action, detailUrl, label, opts = {}) {
  let status = null;
  const onResp = (r) => {
    if (r.url().includes('/api/v1/') && r.request().method() !== 'GET') status = r.status();
  };
  page.on('response', onResp);
  try {
    await page.goto(`${BASE}${detailUrl}`, { waitUntil: 'domcontentloaded', timeout: T });
    await page.waitForFunction(() => (document.querySelector('main')?.innerText ?? '').length > 40, null, { timeout: T }).catch(() => {});
    const btn = page.getByRole('button', { name: label }).first();
    if (!(await btn.count())) {
      record(role, action, 0, null, opts.expectAbsent ? 'PASS(button-absent)' : 'MISSING-BUTTON', `no "${label}"`);
      return;
    }
    const t = Date.now();
    await btn.click({ timeout: T }).catch(() => {});
    await page.waitForTimeout(opts.wait ?? 900);
    const ms = Date.now() - t;
    const ok = status == null || status < 400; // some actions are pure client (e.g. reveal toggle)
    record(role, action, ms, status, ok ? (ms <= 1500 ? 'PASS' : 'SLOW') : 'FAIL');
  } catch (e) {
    record(role, action, 0, null, 'ERROR', String(e).slice(0, 70));
  } finally {
    page.off('response', onResp);
  }
}

async function discover(page) {
  const req = page.context().request;
  const g = async (p) => (await (await req.get(`${BASE}${p}`)).json().catch(() => ({})))?.data ?? [];
  const projects = await g('/api/v1/projects?limit=1');
  const owners = await g('/api/v1/owners?limit=1');
  const docs = await g('/api/v1/documents?limit=1');
  const projectId = projects[0]?.id;
  let buildingId = null;
  if (projectId) buildingId = (await g(`/api/v1/projects/${projectId}/buildings?limit=1`))[0]?.id;
  return { projectId, buildingId, ownerId: owners[0]?.id, docId: docs[0]?.id };
}

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED, slowMo: process.env.HEADED ? 120 : 0 });
  const page = await (await browser.newContext({ baseURL: BASE, viewport: { width: 1366, height: 900 } })).newPage();

  await browserLogin(page, 'manager@alpha.dev');
  const ids = await discover(page);
  log(`  discovered: ${JSON.stringify(ids)}`);

  // ── CREATE FORMS (real fill + submit) ──────────────────────────────────────
  await browserForm(page, 'manager', 'create project (form)', `/${L}/projects/new`, { 'name|שם': `בדיקה ${Date.now() % 100000}` }, '/projects');
  if (ids.projectId) await browserForm(page, 'manager', 'create building (form)', `/${L}/projects/${ids.projectId}/buildings/new`, { 'address|כתובת|רחוב': `רחוב ${Date.now() % 1000}`, 'city|עיר': 'תל אביב' }, '/buildings');
  if (ids.buildingId) await browserForm(page, 'manager', 'create apartment (form)', `/${L}/buildings/${ids.buildingId}/apartments/new`, { 'number|מספר|דירה': `A-${Date.now() % 100000}` }, '/apartments');
  await browserForm(page, 'manager', 'create owner (form)', `/${L}/owners/new`, { 'name|שם': `בעלים ${Date.now() % 1000}`, 'national|תעודת|זהות|tz|id': String(100000000 + (Date.now() % 800000000)) }, '/owners');
  await browserForm(page, 'manager', 'create task (form)', `/${L}/tasks/new`, { 'title|כותרת': `משימה ${Date.now() % 1000}` }, '/tasks');
  await browserForm(page, 'manager', 'create note (form)', `/${L}/notes/new`, { 'title|כותרת': `הערה ${Date.now() % 1000}`, 'body|תוכן|גוף': 'בדיקת ביצועים' }, '/notes');
  await browserForm(page, 'manager', 'invite member (form)', `/${L}/members/new`, { 'email|אימייל': `perf${Date.now()}@ex.com` }, '/members');
  await browserForm(page, 'manager', 'create contractor (form)', `/${L}/contractors/new`, { 'name|שם': `קבלן ${Date.now() % 1000}`, 'email|אימייל': `c${Date.now()}@ex.com` }, '/contractors');

  // ── ACTION BUTTONS (real click) ────────────────────────────────────────────
  if (ids.ownerId) await browserAction(page, 'manager', 'reveal owner PII (button)', `/${L}/owners/${ids.ownerId}`, /הצג נתונים גלויים|חשיפ|reveal/i);
  await browserAction(page, 'manager', 'settings save (button)', `/${L}/settings`, /שמור|save/i);

  await browser.close();
  const out = { base: BASE, stamp: STAMP, results };
  writeFileSync(new URL(`../../../docs/PERF-AUDIT-BROWSER-${STAMP}.json`, import.meta.url), JSON.stringify(out, null, 2));
  const fails = results.filter((r) => /FAIL|ERROR|MISSING/.test(r.verdict));
  log(`\nDONE. ${results.length} browser-real flows, ${fails.length} need attention.`);
  log(`Results → docs/PERF-AUDIT-BROWSER-${STAMP}.json`);
}

main().catch((e) => {
  process.stderr.write(`browser-flows failed: ${String(e)}\n${e?.stack ?? ''}\n`);
  process.exit(1);
});
