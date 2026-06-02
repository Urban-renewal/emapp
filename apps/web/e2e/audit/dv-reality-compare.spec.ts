import { test } from '@playwright/test';

import { USERS, loginAs, WEB } from './_helpers';

/** RIGOR: compare manager vs agent on the SAME action — click a project card to
 *  open it. Isolates "agent can't navigate" (a bug) from "cards aren't clickable
 *  by design" (my selector is wrong). No claim without this comparison. */
for (const [roleKey, projectText] of [
  ['manager', 'Pilot'],
  ['agent', 'ארלוזורוב 14'],
] as const) {
  test(`${roleKey}: project card → does it open?`, async ({ page }) => {
    await loginAs(page, USERS[roleKey]);
    await page.goto(`${WEB}/he/projects`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);

    const anchorLinks = await page.locator('a[href*="/he/projects/"]').count();
    const clickableCards = await page
      .locator('[role="button"], button, [class*="cursor-pointer"]')
      .count();
    const before = page.url();
    await page
      .getByText(projectText, { exact: false })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const navigated = page.url() !== before;

    // eslint-disable-next-line no-console
    console.log(
      `[${roleKey}] navigatedIntoProject=${navigated} url=${page.url().replace(WEB, '')} projectAnchorLinks=${anchorLinks} clickableCardEls=${clickableCards}`,
    );
  });
}
