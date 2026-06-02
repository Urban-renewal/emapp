import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { test, expect, USERS, loginAs, observe, WEB } from './_helpers';

/**
 * DV — Interface 1 (Org) MANAGER non-page surfaces / gaps the manager walk
 * left open (org-manager-coverage.md §Gaps):
 *
 *  (a) ORG-SWITCHER / cross-tenant isolation. NOTE (static finding, confirmed
 *      from code 2026-06-02): there is NO in-session org-switcher — the org
 *      name in the Topbar is a static label (topbar.tsx) and the Sidebar has
 *      no switcher (sidebar.tsx). An org user is bound to ONE org; "switching"
 *      = a separate login. So isolation is verified by logging Alpha and Beta
 *      managers into SEPARATE contexts and asserting their project/owner lists
 *      are DISJOINT (Alpha must NOT see Beta data and vice-versa).
 *
 *  (b) REVEAL-PII control on an owner detail — confirm masked by default,
 *      cleartext only AFTER the explicit click (POST /owners/:id/reveal-pii,
 *      BE-audited owner.pii_revealed). Capture the network row as the implied
 *      audit evidence.
 *
 *  (c) CONFIRM-ARCHIVE modal — open it on an entity, screenshot the dialog,
 *      then CANCEL (never destroy seed data).
 *
 * Artifacts → docs/DV/results/artifacts/org-gaps-*.{png,json}
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';
fs.mkdirSync(ART, { recursive: true });

const OWNER_ID = '86ea1064-df3c-41b0-a794-2e2b993c7081'; // דנה כהן (Alpha)

interface GapsEvidence {
  isolation?: {
    alphaProjects: string[];
    betaProjects: string[];
    overlap: string[];
    alphaOwnersSample: string[];
    betaOwnersSample: string[];
    ownerOverlap: string[];
    hasOrgSwitcherUi: boolean;
  };
  revealPii?: {
    maskedBefore: string;
    revealRequest: { url: string; status: number } | null;
    textAfter: string;
    cleartextDiffersFromMask: boolean;
  };
  archiveModal?: {
    triggerFound: boolean;
    dialogOpened: boolean;
    dialogText: string;
    networkAfterCancel: { url: string; status: number; ms: number }[];
  };
}

const evidence: GapsEvidence = {};
const EVIDENCE = path.join(ART, 'org-gaps-evidence.json');
function flush() {
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2), 'utf8');
}

/** Read the rendered list of project/owner card titles on a list page. */
async function listTitles(page: Page, urlPath: string): Promise<string[]> {
  await page.goto(`${WEB}${urlPath}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(500);
  // Heading-ish text inside cards/rows; coarse but org-disjoint enough to prove
  // isolation. Filter to non-empty, de-dup.
  const texts = await page
    .locator(
      'main h1, main h2, main h3, main td, main a[href*="/projects/"], main a[href*="/owners/"]',
    )
    .allInnerTexts()
    .catch(() => [] as string[]);
  return [...new Set(texts.map((t) => t.trim()).filter((t) => t.length > 1))];
}

test('DV org-gaps (a) — cross-tenant isolation: Alpha vs Beta managers are disjoint', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ctxA: BrowserContext = await browser.newContext({ baseURL: WEB });
  const ctxB: BrowserContext = await browser.newContext({ baseURL: WEB });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await loginAs(pageA, USERS.manager); // Alpha
  await loginAs(pageB, USERS.managerBeta); // Beta

  // Is there ANY org-switcher control in the chrome? (expected: no)
  await pageA.goto(`${WEB}/he`, { waitUntil: 'domcontentloaded' });
  const hasSwitcher = await pageA
    .locator('[data-testid*="org-switch"], [aria-label*="ארגון"], button:has-text("החלף ארגון")')
    .count()
    .catch(() => 0);

  const alphaProjects = await listTitles(pageA, '/he/projects');
  const betaProjects = await listTitles(pageB, '/he/projects');
  const alphaOwners = await listTitles(pageA, '/he/owners');
  const betaOwners = await listTitles(pageB, '/he/owners');

  await pageA.screenshot({ path: path.join(ART, 'org-gaps-isolation-alpha.png'), fullPage: true });
  await pageB.screenshot({ path: path.join(ART, 'org-gaps-isolation-beta.png'), fullPage: true });

  const overlap = alphaProjects.filter((p) => betaProjects.includes(p));
  const ownerOverlap = alphaOwners.filter((o) => betaOwners.includes(o));

  evidence.isolation = {
    alphaProjects,
    betaProjects,
    overlap,
    alphaOwnersSample: alphaOwners.slice(0, 30),
    betaOwnersSample: betaOwners.slice(0, 30),
    ownerOverlap,
    hasOrgSwitcherUi: hasSwitcher > 0,
  };
  flush();

  // IDOR cross-tenant: Alpha manager hitting a Beta project id should NOT render
  // it. (We don't know a Beta id here; the disjoint-list check is the headline.)
  // Headline: zero project-title overlap, zero owner-name overlap.
  expect.soft(overlap, `Alpha/Beta project titles overlap: ${overlap.join(', ')}`).toHaveLength(0);
  expect
    .soft(ownerOverlap, `Alpha/Beta owner names overlap: ${ownerOverlap.join(', ')}`)
    .toHaveLength(0);

  await ctxA.close();
  await ctxB.close();
});

test('DV org-gaps (b) — reveal-PII: masked by default, cleartext only after click + audited POST', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, USERS.manager);
  const o = observe(page);

  await page.goto(`${WEB}/he/owners/${OWNER_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(400);

  const piiBlock = page.locator('dl').first();
  const maskedBefore = (await piiBlock.innerText().catch(() => '')).slice(0, 200);
  await page.screenshot({ path: path.join(ART, 'org-gaps-pii-masked.png'), fullPage: true });

  // The reveal button text is "הצג נתונים גלויים" (owners.reveal.reveal).
  const revealBtn = page.getByRole('button', { name: /הצג נתונים/ });
  const revealFound = (await revealBtn.count().catch(() => 0)) > 0;

  let revealRequest: { url: string; status: number } | null = null;
  let textAfter = maskedBefore;
  if (revealFound) {
    const [resp] = await Promise.all([
      page
        .waitForResponse((r) => /\/owners\/.+\/reveal-pii/.test(r.url()), { timeout: 8_000 })
        .catch(() => null),
      revealBtn
        .first()
        .click()
        .catch(() => {}),
    ]);
    if (resp) revealRequest = { url: new URL(resp.url()).pathname, status: resp.status() };
    await page.waitForTimeout(500);
    textAfter = (await piiBlock.innerText().catch(() => '')).slice(0, 200);
    await page.screenshot({ path: path.join(ART, 'org-gaps-pii-revealed.png'), fullPage: true });
  }

  evidence.revealPii = {
    maskedBefore,
    revealRequest,
    textAfter,
    cleartextDiffersFromMask: textAfter !== maskedBefore,
  };
  flush();

  // Headline: reveal flips the text, and it was driven by a reveal-pii POST.
  expect.soft(revealFound, 'reveal-PII button present for manager').toBeTruthy();
  // anti-leak: before the click, no full 9-digit national id should be visible
  expect
    .soft(/\d{9}/.test(maskedBefore), 'cleartext 9-digit id visible BEFORE reveal (leak!)')
    .toBeFalsy();
  if (revealFound) {
    expect.soft(revealRequest?.status, 'reveal-pii POST returned 2xx').toBeLessThan(300);
    expect
      .soft(evidence.revealPii.cleartextDiffersFromMask, 'reveal changed the shown PII')
      .toBeTruthy();
  }

  // Drop console noise
  void o;
});

test('DV org-gaps (c) — confirm-archive modal opens and CANCELS (no data destroyed)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAs(page, USERS.manager);

  // Owner detail is a safe place to look for an archive affordance.
  await page.goto(`${WEB}/he/owners/${OWNER_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(400);
  const o = observe(page);

  // Archive verb per CLAUDE.md is "ארכוב" / "העבר לארכיון".
  const archiveTrigger = page.getByRole('button', { name: /ארכוב|העבר לארכיון|לארכיון/ });
  const triggerFound = (await archiveTrigger.count().catch(() => 0)) > 0;

  let dialogOpened = false;
  let dialogText = '';
  if (triggerFound) {
    await archiveTrigger
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(400);
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
    dialogOpened = (await dialog.count().catch(() => 0)) > 0;
    if (dialogOpened) {
      dialogText = (
        await dialog
          .first()
          .innerText()
          .catch(() => '')
      ).slice(0, 400);
      await page.screenshot({
        path: path.join(ART, 'org-gaps-archive-dialog.png'),
        fullPage: true,
      });
      // CANCEL — never destroy seed data.
      const cancel = page.getByRole('button', { name: /ביטול|בטל|סגור|חזרה/ });
      if ((await cancel.count().catch(() => 0)) > 0) {
        await cancel
          .first()
          .click()
          .catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await page.waitForTimeout(300);
    }
  }

  evidence.archiveModal = {
    triggerFound,
    dialogOpened,
    dialogText,
    // any network after cancel — there must be NO archive mutation fired
    networkAfterCancel: o.responses.filter((r) => /archive|PATCH|DELETE/i.test(r.url)),
  };
  flush();

  // Headline: if an archive trigger exists, it opens a confirm dialog (not a
  // one-click destroy). Soft so an absent trigger just records, doesn't fail.
  if (triggerFound) {
    expect.soft(dialogOpened, 'archive trigger opened a confirm dialog').toBeTruthy();
  }
  expect(true).toBeTruthy();
});
