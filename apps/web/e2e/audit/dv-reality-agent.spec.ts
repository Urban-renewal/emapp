import { test } from '@playwright/test';

import { USERS, loginAs, WEB } from './_helpers';

/** REALITY check (action-level): what does the AGENT actually SEE + CAN DO,
 *  not just "the page rendered". API says agent is assigned 2 projects. */
test('AGENT reality — projects render + nav gating + create action', async ({ page }) => {
  await loginAs(page, USERS.agent);

  await page.goto(`${WEB}/he/projects`);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);

  const projectLinks = await page.locator('a[href*="/he/projects/"]').count();
  const mainText = (
    await page
      .locator('main')
      .innerText()
      .catch(() => '')
  ).slice(0, 800);
  const nav = await page
    .locator('aside a, nav a')
    .allInnerTexts()
    .catch(() => []);

  // nav items the agent must NOT have:
  const forbidden = ['חברי ארגון', 'יומן ביקורת', 'הגדרות'];
  const leakedNav = nav.filter((n) => forbidden.some((f) => n.includes(f)));

  // is there a "create project" control for the agent?
  const createBtn = await page.getByText('צור פרויקט', { exact: false }).count();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        renderedProjectLinks: projectLinks,
        navItems: nav,
        leakedForbiddenNav: leakedNav,
        createProjectControlVisible: createBtn,
        mainTextHead: mainText,
      },
      null,
      2,
    ),
  );
});
