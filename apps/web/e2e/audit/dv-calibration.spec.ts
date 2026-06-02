import { mkdirSync } from 'node:fs';

import { test, expect } from '@playwright/test';

import { USERS, loginAs } from './_helpers';

/**
 * DV calibration — item #1 (manager / dashboard).
 *
 * Proves the DV artifact-bundle standard via Playwright (reliable screenshot —
 * Claude-in-Chrome's CDP capture froze in this env): screenshot + network +
 * console + DOM assertion vs oracle. Run headed so the owner watches:
 *   pnpm --filter @emapp/web exec playwright test \
 *     --config playwright.audit.config.ts --headed e2e/audit/dv-calibration.spec.ts
 */
const ART = 'C:/emapp/docs/DV/results/artifacts';

test('DV calibration — manager dashboard artifact bundle', async ({ page }) => {
  const consoleErrors: string[] = [];
  const api: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/')) api.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  // login is setup (out of DV scope) — loginAs handles the FUNC-4 race.
  await loginAs(page, USERS.manager);
  await page.goto('/he');
  await page.waitForLoadState('networkidle');

  // Artifact 1 — screenshot (the reliable visual capture).
  mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: `${ART}/org-manager-dashboard.png`, fullPage: true });

  // Artifact 2 — DOM / oracle anchors (KPIs render).
  const main = await page.locator('main').innerText();
  await expect(page.getByText('פרויקטים פעילים')).toBeVisible();
  await expect(page.getByText('דיירים במערכת')).toBeVisible();

  // Artifact 3 + 4 — network + console captured to the run log.
  console.log('[DV] API calls:\n  ' + (api.join('\n  ') || '(none)'));
  console.log('[DV] console errors:\n  ' + (consoleErrors.join('\n  ') || '(none)'));
  console.log('[DV] dashboard main text:\n' + main);

  // DV-ORG-1 (jargon leak) — flag if internal slice/phase refs are user-visible.
  for (const ref of ['A.S12', 'Phase 2', 'A.S']) {
    if (main.includes(ref))
      console.log(`[DV][FINDING DV-ORG-1] internal ref visible in UI: "${ref}"`);
  }
});
