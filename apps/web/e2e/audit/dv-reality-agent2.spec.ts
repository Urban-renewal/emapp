import { test } from '@playwright/test';

import { USERS, loginAs, WEB } from './_helpers';

/** ACTION reality: agent — can it navigate into a project, and what does
 *  "create project" actually do? Capture real outcomes + network statuses. */
test('AGENT actions — navigate into project + create attempt', async ({ page }) => {
  const api: string[] = [];
  const errs: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/'))
      api.push(`${r.status()} ${r.request().method()} ${r.url().split('/api/v1/')[1]}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });

  await loginAs(page, USERS.agent);
  await page.goto(`${WEB}/he/projects`);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);

  // 1) try to navigate INTO the agent's own assigned project
  const before = page.url();
  await page
    .getByText('ארלוזורוב 14', { exact: false })
    .first()
    .click({ timeout: 5000 })
    .catch((e) => errs.push('project-click: ' + e.message));
  await page.waitForTimeout(1500);
  const afterProjectClick = page.url();

  // 2) try the "create project" control
  await page.goto(`${WEB}/he/projects`);
  await page.waitForTimeout(500);
  await page
    .getByText('צור פרויקט', { exact: false })
    .first()
    .click({ timeout: 5000 })
    .catch((e) => errs.push('create-click: ' + e.message));
  await page.waitForTimeout(1500);
  const afterCreateClick = page.url();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        projectCardClickable: afterProjectClick !== before,
        urlAfterProjectClick: afterProjectClick.replace(WEB, ''),
        urlAfterCreateClick: afterCreateClick.replace(WEB, ''),
        apiCalls: api,
        consoleErrors: errs,
      },
      null,
      2,
    ),
  );
});
