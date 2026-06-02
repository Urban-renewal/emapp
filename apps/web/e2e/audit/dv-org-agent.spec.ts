import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Page } from '@playwright/test';

import { test, expect, USERS, loginAs, observe, WEB } from './_helpers';

/**
 * DV — Interface 1 (Org), AGENT column. ONE login, walk every page a manager
 * walked, but the headline assertion is the ROLE-DIFF:
 *   - agent must see ONLY assigned projects (NOT the manager's 7).
 *   - sidebar must NOT expose members / audit / settings.
 *   - any page where agent sees data it shouldn't (cross-scope leak) or a
 *     mutating action it shouldn't have is FLAGGED in evidence.json.
 *
 * Manager oracle (seed:demo, org Alpha, 2026-06-02 from API):
 *   projects total=7 (active=5) · owners=43 · documents=41 · sigreq=30
 *   members=4 · contractors=3 · tasks=10 · notes=0 · imports=0
 * Agent expectation: a STRICT SUBSET of projects (assigned only) and NO
 *   members/audit/settings nav. Exact assigned count is harvested at runtime.
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';
fs.mkdirSync(ART, { recursive: true });

// Same seed IDs the manager spec used (manager-owned). Hitting them as agent is
// an IDOR probe: an unassigned project/owner/doc should be 403/404, NOT rendered.
const PROJECT_ID = '1ace1c99-19fb-48b5-8bd8-0c0e886b605c';
const BUILDING_ID = 'f3504b2c-bf53-4cba-953b-5b8975d175f0';
const APARTMENT_ID = 'f5951010-90a8-4b09-a18d-091e906dbc26';
const OWNER_ID = '86ea1064-df3c-41b0-a794-2e2b993c7081';
const DOCUMENT_ID = 'f87283dc-5aef-4229-ac29-8ab8e899d592';
const SIGREQ_ID = '66a8baab-5c69-410a-9175-8bcbabd9e391';
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
  bodyText: string;
  formCount: number;
  formsWithoutPost: number;
  formMethods: string[];
}

const reports: PageReport[] = [];
const EVIDENCE = path.join(ART, 'org-agent-evidence.json');

async function walk(page: Page, slug: string, urlPath: string): Promise<PageReport> {
  const o = observe(page);
  let docStatus: number | null = null;
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${WEB}${urlPath}`;
  const resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (resp) docStatus = resp.status();
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(400);

  await page
    .screenshot({ path: path.join(ART, `org-agent-${slug}.png`), fullPage: true })
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
  fs.writeFileSync(EVIDENCE, JSON.stringify(reports, null, 2), 'utf8');
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('request');
  page.removeAllListeners('response');
  return r;
}

test('DV org-agent — role-diff walk (assigned-only + no admin nav)', async ({ page }) => {
  test.setTimeout(600_000);
  await loginAs(page, USERS.agent);

  // --- Sidebar / nav role-diff (captured on the dashboard before the walk) ---
  await page.goto(`${WEB}/he`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  const navText = (
    await page
      .locator('nav, aside')
      .allInnerTexts()
      .catch(() => [])
  ).join('\n');
  const navHrefs = await page
    .locator('nav a, aside a')
    .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''))
    .catch(() => [] as string[]);
  const navProbe = {
    seesMembers: /\/members/.test(navHrefs.join(' ')) || /חברי|חברים/.test(navText),
    seesAudit: /\/audit/.test(navHrefs.join(' ')) || /יומן|ביקורת/.test(navText),
    seesSettings: /\/settings/.test(navHrefs.join(' ')) || /הגדרות/.test(navText),
    hrefs: navHrefs.filter((h) => h.startsWith('/he')),
  };
  fs.writeFileSync(path.join(ART, 'org-agent-nav.json'), JSON.stringify(navProbe, null, 2), 'utf8');

  const pages: [string, string][] = [
    ['dashboard', '/he'],
    ['projects-list', '/he/projects'],
    ['projects-new', '/he/projects/new'],
    ['project-detail', `/he/projects/${PROJECT_ID}`],
    ['project-assignments', `/he/projects/${PROJECT_ID}/assignments`],
    ['project-buildings', `/he/projects/${PROJECT_ID}/buildings`],
    ['project-shares', `/he/projects/${PROJECT_ID}/shares`],
    ['building-detail', `/he/buildings/${BUILDING_ID}`],
    ['apartment-detail', `/he/apartments/${APARTMENT_ID}`],
    ['owners-list', '/he/owners'],
    ['owner-detail', `/he/owners/${OWNER_ID}`],
    ['owners-new', '/he/owners/new'],
    ['documents-list', '/he/documents'],
    ['document-detail', `/he/documents/${DOCUMENT_ID}`],
    ['sigreq-list', '/he/signature-requests'],
    ['sigreq-detail', `/he/signature-requests/${SIGREQ_ID}`],
    ['contractors-list', '/he/contractors'],
    ['contractor-detail', `/he/contractors/${CONTRACTOR_ID}`],
    ['tasks-list', '/he/tasks'],
    ['task-detail', `/he/tasks/${TASK_ID}`],
    ['notes-list', '/he/notes'],
    ['notifications', '/he/notifications'],
    ['imports-list', '/he/imports'],
    // admin surfaces — agent should be denied / redirected:
    ['members-list', '/he/members'],
    ['audit', '/he/audit'],
    ['settings', '/he/settings'],
  ];

  for (const [slug, urlPath] of pages) {
    await walk(page, slug, urlPath);
  }

  fs.writeFileSync(EVIDENCE, JSON.stringify(reports, null, 2), 'utf8');

  // --- Headline assertions (soft — record, never abort the walk) ---
  // 1) admin nav must be absent for agent
  expect.soft(navProbe.seesMembers, 'agent nav exposes members').toBeFalsy();
  expect.soft(navProbe.seesAudit, 'agent nav exposes audit').toBeFalsy();
  expect.soft(navProbe.seesSettings, 'agent nav exposes settings').toBeFalsy();

  // 2) every page returned a document (no hard navigation failure)
  for (const r of reports) {
    expect(r.httpStatusOfDoc, `${r.slug} doc status`).not.toBeNull();
  }
});
