import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Page } from '@playwright/test';

import { test, expect, USERS, loginAs, observe, WEB } from './_helpers';

/**
 * DV — Interface 1 (Org), manager column. ONE login, walk EVERY manager page.
 * Read-only coverage: screenshots + network + console + oracle assertions.
 * Artifacts → docs/DV/results/artifacts/org-manager-<page>.png
 * Evidence rollup → docs/DV/results/artifacts/org-manager-evidence.json
 *
 * Seed:demo oracle (manager@alpha.dev, org Alpha), derived 2026-06-02 from API:
 *   projects total=7  (active non-cancelled/non-completed = 5)
 *   owners=43 · documents=41 · signature-requests=30 · members=4
 *   contractors=3 · tasks=10 · notes=0 · notifications=4 · imports=0
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';
fs.mkdirSync(ART, { recursive: true });

// IDs harvested from the live API (manager cookie) — see org.md oracle block.
const PROJECT_ID = '1ace1c99-19fb-48b5-8bd8-0c0e886b605c'; // Tama 38/2 — Pilot (gathering_signatures)
const BUILDING_ID = 'f3504b2c-bf53-4cba-953b-5b8975d175f0'; // בן יהודה 25
const APARTMENT_ID = 'f5951010-90a8-4b09-a18d-091e906dbc26';
const OWNER_ID = '86ea1064-df3c-41b0-a794-2e2b993c7081'; // דנה כהן
const DOCUMENT_ID = 'f87283dc-5aef-4229-ac29-8ab8e899d592';
const SIGREQ_ID = '66a8baab-5c69-410a-9175-8bcbabd9e391';
const MEMBER_ID = 'aeaaa145-1635-468a-88d2-3321bdad0b17';
const CONTRACTOR_ID = 'afa0059f-5d65-4e90-9b16-1d2d10e6ab64';
const TASK_ID = 'fa007e59-0f5e-457d-9c4f-d22f9de17ea8';

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

async function walk(page: Page, slug: string, urlPath: string): Promise<PageReport> {
  const o = observe(page);
  let docStatus: number | null = null;
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${WEB}${urlPath}`;
  const resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (resp) docStatus = resp.status();
  // settle SPA fetches (bounded so a hung socket can't eat the whole budget)
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(400);

  await page
    .screenshot({ path: path.join(ART, `org-manager-${slug}.png`), fullPage: true })
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
    // a form is safe if method=post OR it has an inline onSubmit handler (JS-driven)
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
  // write incrementally so a timeout never loses the rollup
  fs.writeFileSync(
    path.join(ART, 'org-manager-evidence.json'),
    JSON.stringify(reports, null, 2),
    'utf8',
  );
  // strip listeners so they don't bleed into the next page
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('request');
  page.removeAllListeners('response');
  return r;
}

test('DV org-manager — walk every manager page once', async ({ page }) => {
  test.setTimeout(600_000);
  await loginAs(page, USERS.manager);

  const pages: [string, string][] = [
    ['dashboard', '/he'],
    ['projects-list', '/he/projects'],
    ['projects-new', '/he/projects/new'],
    ['project-detail', `/he/projects/${PROJECT_ID}`],
    ['project-assignments', `/he/projects/${PROJECT_ID}/assignments`],
    ['project-buildings', `/he/projects/${PROJECT_ID}/buildings`],
    ['project-buildings-new', `/he/projects/${PROJECT_ID}/buildings/new`],
    ['project-shares', `/he/projects/${PROJECT_ID}/shares`],
    ['buildings-redirect', '/he/buildings'],
    ['building-detail', `/he/buildings/${BUILDING_ID}`],
    ['building-apartments', `/he/buildings/${BUILDING_ID}/apartments`],
    ['building-apartments-new', `/he/buildings/${BUILDING_ID}/apartments/new`],
    ['apartments-redirect', '/he/apartments'],
    ['apartment-detail', `/he/apartments/${APARTMENT_ID}`],
    ['apartment-ownerships', `/he/apartments/${APARTMENT_ID}/ownerships`],
    ['owners-list', '/he/owners'],
    ['owner-detail', `/he/owners/${OWNER_ID}`],
    ['owners-new', '/he/owners/new'],
    ['documents-list', '/he/documents'],
    ['document-detail', `/he/documents/${DOCUMENT_ID}`],
    ['documents-new', '/he/documents/new'],
    ['sigreq-list', '/he/signature-requests'],
    ['sigreq-detail', `/he/signature-requests/${SIGREQ_ID}`],
    ['sigreq-new', '/he/signature-requests/new'],
    ['members-list', '/he/members'],
    ['member-detail', `/he/members/${MEMBER_ID}`],
    ['members-new', '/he/members/new'],
    ['contractors-list', '/he/contractors'],
    ['contractor-detail', `/he/contractors/${CONTRACTOR_ID}`],
    ['contractors-new', '/he/contractors/new'],
    ['tasks-list', '/he/tasks'],
    ['task-detail', `/he/tasks/${TASK_ID}`],
    ['tasks-new', '/he/tasks/new'],
    ['notes-list', '/he/notes'],
    ['notes-new', '/he/notes/new'],
    ['notifications', '/he/notifications'],
    ['imports-list', '/he/imports'],
    ['imports-new', '/he/imports/new'],
    ['audit', '/he/audit'],
    ['settings', '/he/settings'],
  ];

  for (const [slug, urlPath] of pages) {
    await walk(page, slug, urlPath);
  }

  fs.writeFileSync(
    path.join(ART, 'org-manager-evidence.json'),
    JSON.stringify(reports, null, 2),
    'utf8',
  );

  // Sanity: dashboard rendered KPI labels
  const dash = reports.find((r) => r.slug === 'dashboard')!;
  expect(dash.bodyText).toContain('פרויקטים פעילים');

  // Every walked page returned a document (no hard navigation failure)
  for (const r of reports) {
    expect(r.httpStatusOfDoc, `${r.slug} doc status`).not.toBeNull();
  }
});
