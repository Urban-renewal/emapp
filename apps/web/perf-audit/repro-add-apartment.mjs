/**
 * Reproduce the owner's "add apartment fails for no apparent reason" — real
 * Chromium against the running local stack. Captures the FE form, the POST
 * response (status + body), console errors, and whether it succeeded.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3001';
const L = 'he';
const CREDS = { email: 'manager@alpha.dev', password: 'DevPassword123!' };
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ baseURL: BASE })).newPage();

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 160)));
const apiResponses = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/v1/') && r.request().method() !== 'GET') {
    let body = '';
    try {
      body = (await r.text()).slice(0, 1500);
    } catch {}
    apiResponses.push({ m: r.request().method(), url: r.url().replace(BASE, ''), status: r.status(), body });
  }
});

// login via the request API — sets the session cookies in the shared context
// WITHOUT the flaky cold-compile of the login→dashboard form render.
const loginResp = await page.context().request.post(`${BASE}/api/v1/auth/login`, { data: CREDS });
log('api login:', loginResp.status());
if (!loginResp.ok()) {
  log('LOGIN FAILED — abort');
  await browser.close();
  process.exit(0);
}

// buildings are PROJECT-scoped. Chain: project → its buildings → a building id.
const req = page.context().request;
const pj = await (await req.get(`${BASE}/api/v1/projects?limit=5`)).json().catch(() => ({}));
const projectId = pj?.data?.[0]?.id ?? null;
log('projectId:', projectId);
let buildingId = null;
if (projectId) {
  const pbResp = await req.get(`${BASE}/api/v1/projects/${projectId}/buildings?limit=5`);
  const pb = await pbResp.json().catch(() => ({}));
  log('project-buildings status:', pbResp.status(), 'count:', pb?.data?.length ?? 0);
  buildingId = pb?.data?.[0]?.id ?? null;
}
log('buildingId:', buildingId);

if (!buildingId) {
  log('NO BUILDING — cannot reach the apartment form. (Is the local DB seeded with a building?)');
  await browser.close();
  process.exit(0);
}

// go to the add-apartment form (generous wait — cold dev compile of the route)
const formUrl = `${BASE}/${L}/buildings/${buildingId}/apartments/new`;
await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('input', { timeout: 90000 }).catch(() => log('no input appeared in 90s'));
await page.waitForTimeout(1500);
log('form url:', page.url());

// dump the form fields so we fill the right ones
const fields = await page.evaluate(() =>
  [...document.querySelectorAll('input,select,textarea')].map((el) => ({
    name: el.getAttribute('name'),
    type: el.getAttribute('type') || el.tagName.toLowerCase(),
    placeholder: el.getAttribute('placeholder'),
    required: el.hasAttribute('required'),
  })),
);
log('form fields:', JSON.stringify(fields));
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
);
log('buttons:', JSON.stringify(buttons));

// fill the most likely fields (number/designation + parcel/floor) generically
const num = 'A-' + Math.floor(Math.random() * 100000);
await page.evaluate((n) => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    d.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const el of document.querySelectorAll('input')) {
    const name = (el.getAttribute('name') || '') + (el.getAttribute('placeholder') || '');
    if (/number|מספר|designation|דירה/i.test(name)) set(el, n);
    else if (/floor|קומה/i.test(name)) set(el, '3');
    else if (/parcel|חלקה|תת/i.test(name)) set(el, '7');
    else if (el.type === 'text' && !el.value) set(el, n);
  }
}, num);

const before = page.url();
// submit
const submitBtn = page
  .locator('button[type=submit]')
  .or(page.getByRole('button', { name: /הוסף|צור|שמור|create|add|save/i }))
  .first();
await submitBtn.click().catch((e) => log('submit click err:', String(e).slice(0, 80)));
await page.waitForTimeout(8000);

log('\n=== RESULT ===');
log('url before:', before);
log('url after :', page.url());
log('navigated (success?):', page.url() !== before && !page.url().includes('/new'));
log('console errors:', JSON.stringify(consoleErrors));
log('non-GET API responses:');
for (const r of apiResponses) log('  ', r.m, r.url, '→', r.status, r.body);
// any visible error text on the page
const errText = await page.evaluate(() => {
  const t = document.querySelector('main')?.innerText || '';
  const m = t.match(/.{0,60}(שגיא|נכשל|error|failed|לא ניתן|invalid).{0,80}/i);
  return m ? m[0] : null;
});
log('visible error text:', errText);

await browser.close();
