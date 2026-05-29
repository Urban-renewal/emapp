import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from './_helpers';

/**
 * LAYER 1 — REACHABILITY (broad/shallow). Drives the REAL app as Manager.
 * Per route: load, capture console/page errors + 4xx/5xx, enumerate every
 * interactive element (single page.evaluate — fast, no stale handles),
 * classify links (nav targets, inventoried) and submit/verb buttons
 * (MUTATING — inventoried, never clicked: read-only audit), then click the
 * DEAD-prone non-link non-mutating controls and classify
 * WORKS/DEAD/HOLLOW. Each route's record is written immediately to
 * docs/audit/artifacts/layer1/<name>.json so a later hang loses nothing.
 */

const AUTH = join(__dirname, '.auth', 'manager.json');
test.use({ storageState: AUTH });

const OUT = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'layer1');
mkdirSync(OUT, { recursive: true });

const ID = {
  project: 'c1ed4913-b6ee-4471-81ee-8262276437d2',
  building: 'e9a255c9-9842-430f-a2ca-b124da89f79c',
  apartment: 'b606d92b-3e6d-4401-8bef-b80d46af31d9',
  owner: 'e776ee5e-9b41-4507-af07-457de3d5cb2a',
  document: 'e7adaaa5-c610-4fb4-afff-f8c43bbd807d',
  sigReq: '7f1088f0-5fc2-48b0-bc6f-8c8b9d81d6ba',
  member: '44ab57af-3f7d-4bd9-b583-e80c3e6b2cce',
  task: '88c7b8ff-cfeb-4b42-9f57-fb09796cfb70',
};

const ROUTES: { path: string; name: string }[] = [
  { path: '/he', name: 'dashboard-home' },
  { path: '/he/projects', name: 'projects-list' },
  { path: '/he/projects/new', name: 'projects-new' },
  { path: `/he/projects/${ID.project}`, name: 'project-detail' },
  { path: `/he/projects/${ID.project}/assignments`, name: 'project-assignments' },
  { path: `/he/projects/${ID.project}/buildings`, name: 'project-buildings' },
  { path: `/he/projects/${ID.project}/buildings/new`, name: 'project-buildings-new' },
  { path: `/he/projects/${ID.project}/shares`, name: 'project-shares' },
  { path: '/he/buildings', name: 'buildings-list' },
  { path: `/he/buildings/${ID.building}`, name: 'building-detail' },
  { path: `/he/buildings/${ID.building}/apartments`, name: 'building-apartments' },
  { path: `/he/buildings/${ID.building}/apartments/new`, name: 'building-apartments-new' },
  { path: '/he/apartments', name: 'apartments-list' },
  { path: `/he/apartments/${ID.apartment}`, name: 'apartment-detail' },
  { path: `/he/apartments/${ID.apartment}/ownerships`, name: 'apartment-ownerships' },
  { path: '/he/owners', name: 'owners-list' },
  { path: '/he/owners/new', name: 'owners-new' },
  { path: `/he/owners/${ID.owner}`, name: 'owner-detail' },
  { path: '/he/documents', name: 'documents-list' },
  { path: '/he/documents/new', name: 'documents-new' },
  { path: `/he/documents/${ID.document}`, name: 'document-detail' },
  { path: '/he/imports', name: 'imports-list' },
  { path: '/he/imports/new', name: 'imports-new' },
  { path: '/he/members', name: 'members-list' },
  { path: '/he/members/new', name: 'members-new' },
  { path: `/he/members/${ID.member}`, name: 'member-detail' },
  { path: '/he/contractors', name: 'contractors-list' },
  { path: '/he/contractors/new', name: 'contractors-new' },
  { path: '/he/signature-requests', name: 'sigreq-list' },
  { path: '/he/signature-requests/new', name: 'sigreq-new' },
  { path: `/he/signature-requests/${ID.sigReq}`, name: 'sigreq-detail' },
  { path: '/he/tasks', name: 'tasks-list' },
  { path: '/he/tasks/new', name: 'tasks-new' },
  { path: `/he/tasks/${ID.task}`, name: 'task-detail' },
  { path: '/he/notes', name: 'notes-list' },
  { path: '/he/notes/new', name: 'notes-new' },
  { path: '/he/notifications', name: 'notifications' },
  { path: '/he/audit', name: 'audit' },
  { path: '/he/settings', name: 'settings' },
];

const MUTATING =
  /שמור|מחק|אישור|אשר|שלח|צור|הוסף|עדכן|ארכוב|ארכב|הזמן|הזמ|חתו|בטל|ביטול|אפס|מחיק|הענק|נתק|revoke|delete|save|submit|send|create|invite|sign|archive|remove|confirm|logout|התנתק|יציאה/i;

test.describe.configure({ timeout: 35_000 });

// Only scan a subset when SCAN_ONLY is set (validation runs).
const only = process.env['SCAN_ONLY']?.split(',');
const routes = only ? ROUTES.filter((r) => only.includes(r.name)) : ROUTES;

for (const route of routes) {
  test(`L1 ${route.name}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const httpErrors: { url: string; status: number }[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (
        /Connection closed|WebSocket|ResizeObserver|HMR|Hot Module|favicon|Download the React|Failed to load resource/i.test(
          t,
        )
      )
        return;
      consoleErrors.push(t.slice(0, 200));
    });
    page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().includes('/api/v1')) {
        httpErrors.push({ url: r.url().replace('http://localhost:3000', ''), status: r.status() });
      }
    });

    let navStatus: number | null = null;
    try {
      const resp = await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      navStatus = resp?.status() ?? null;
    } catch {
      /* record below */
    }
    await page.waitForTimeout(1200);

    const finalUrl = page.url();
    const redirectedToLogin = finalUrl.includes('/login');

    // Single-pass enumeration in the page context (fast, stale-proof).
    const enum_ = await page
      .evaluate(() => {
        const sel =
          'button, a, [role=button], [role=tab], [class*=card], [class*=tile], [class*=stat], [class*=kpi], tr[role=row], [data-testid]';
        const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
        const bodyText = document.body.innerText || '';
        return {
          bodyText: bodyText.slice(0, 4000),
          items: els.slice(0, 200).map((e, i) => ({
            i,
            tag: e.tagName.toLowerCase(),
            type: e.getAttribute('type'),
            role: e.getAttribute('role'),
            text: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('title') || '')
              .trim()
              .slice(0, 40),
            href: e.getAttribute('href'),
            disabled:
              (e as HTMLButtonElement).disabled === true ||
              e.getAttribute('aria-disabled') === 'true',
            cls: (e.className?.toString?.() || '').slice(0, 60),
          })),
        };
      })
      .catch(() => ({ bodyText: '', items: [] as any[] }));

    const items = enum_.items;
    const hollowSignals = [
      'בקרוב',
      'Coming soon',
      'אין נתונים',
      'אין עדיין',
      'לא נמצא',
      'בפיתוח',
      'אין משימות',
      'אין מסמכים',
      'אין פרויקטים',
      'ריק',
    ].filter((s) => enum_.bodyText.includes(s));
    const navTargets = [
      ...new Set(
        items
          .filter((x) => x.tag === 'a' && x.href && !/^(mailto:|tel:|https?:)/.test(x.href))
          .map((x) => x.href),
      ),
    ];
    const mutatingCount = items.filter((x) => x.type === 'submit' || MUTATING.test(x.text)).length;
    const disabledCount = items.filter((x) => x.disabled).length;

    // DEAD-prone click candidates: non-link, non-mutating, enabled,
    // cardish/tab/button. Cap 6. Stop after first navigation.
    const candidates = items
      .filter((x) => {
        if (x.disabled || x.href) return false;
        if (x.type === 'submit' || MUTATING.test(x.text)) return false;
        const cardish = /card|tile|stat|kpi/i.test(x.cls) || x.role === 'row';
        return cardish || x.role === 'tab' || x.tag === 'button';
      })
      .slice(0, 6);

    const clicks: { label: string; outcome: 'WORKS' | 'DEAD' | 'HOLLOW'; detail: string }[] = [];
    for (const c of candidates) {
      const before = page.url();
      let fired = false;
      const onReq = (r: import('@playwright/test').Request) => {
        if (r.url().includes('/api/v1')) fired = true;
      };
      page.on('request', onReq);
      const dlgBefore = await page
        .locator('[role=dialog],[role=menu],[data-state=open]')
        .count()
        .catch(() => 0);
      // Re-locate by stable-ish text/class via nth match on the same selector index.
      const loc = page
        .locator(
          'button, a, [role=button], [role=tab], [class*=card], [class*=tile], [class*=stat], [class*=kpi], tr[role=row], [data-testid]',
        )
        .nth(c.i);
      const clicked = await loc
        .click({ timeout: 2000, trial: false })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(400);
      page.off('request', onReq);
      const after = page.url();
      const dlgAfter = await page
        .locator('[role=dialog],[role=menu],[data-state=open]')
        .count()
        .catch(() => 0);
      let outcome: 'WORKS' | 'DEAD' | 'HOLLOW' = 'DEAD';
      let detail = clicked ? 'no effect' : 'not actionable';
      if (after !== before) {
        outcome = 'WORKS';
        detail = `nav → ${new URL(after).pathname}`;
        clicks.push({ label: c.text || `${c.tag}#${c.i}`, outcome, detail });
        break; // left the page; stop
      } else if (dlgAfter > dlgBefore) {
        outcome = 'WORKS';
        detail = 'opened dialog/menu';
        await page.keyboard.press('Escape').catch(() => {});
      } else if (fired) {
        outcome = 'WORKS';
        detail = 'fired api request';
      }
      clicks.push({ label: c.text || `${c.tag}#${c.i}`, outcome, detail });
    }

    const record = {
      name: route.name,
      path: route.path,
      navStatus,
      finalUrl,
      redirectedToLogin,
      httpErrors,
      consoleErrors,
      pageErrors,
      elementCount: items.length,
      mutatingCount,
      disabledCount,
      navTargets,
      hollowSignals,
      clicks,
    };
    writeFileSync(join(OUT, `${route.name}.json`), JSON.stringify(record, null, 2));
    expect(true).toBeTruthy();
  });
}
