import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, WEB } from './_helpers';

/**
 * ERROR HANDLING — what does the user SEE when things go wrong?
 * Intercepts client-side /api/v1 calls (TanStack) and forces BE-down (abort),
 * 500, and 404, then captures the rendered text + whether the page crashed
 * (blank / console error) vs degraded gracefully (Hebrew message + retry).
 * Output: docs/audit/artifacts/coverage/error-handling.json
 */
const OUT = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'coverage');
mkdirSync(OUT, { recursive: true });
test.use({ storageState: join(__dirname, '.auth', 'manager.json') });
test.describe.configure({ timeout: 90_000 });

const results: any[] = [];

async function probe(
  page: any,
  label: string,
  url: string,
  listApi: RegExp,
  mode: 'abort' | 'fail500',
) {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e: Error) => consoleErrors.push(e.message.slice(0, 120)));
  await page.route(listApi, (route: any) => {
    if (mode === 'abort') return route.abort('failed');
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error' } }),
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const bodyText =
    (await page
      .locator('body')
      .innerText()
      .catch(() => '')) || '';
  const hasHebrewError = /שגיא|נכשל|בעיה|לא הצלחנו|נסה|שוב|תקלה/.test(bodyText);
  const hasRetry =
    (await page
      .getByRole('button', { name: /נסה|שוב|retry/i })
      .count()
      .catch(() => 0)) > 0;
  const looksBlank = bodyText.trim().length < 40;
  results.push({
    scenario: label,
    mode,
    hasHebrewError,
    hasRetry,
    looksBlank,
    crashed: consoleErrors.length > 0,
    pageErrors: consoleErrors,
    bodySample: bodyText.replace(/\s+/g, ' ').slice(0, 180),
  });
  await page.unroute(listApi);
}

test('error UX: list pages under BE-down (abort) + 500', async ({ page }) => {
  await probe(
    page,
    'projects list — BE down (abort)',
    `${WEB}/he/projects`,
    /\/api\/v1\/projects/,
    'abort',
  );
  await probe(page, 'projects list — 500', `${WEB}/he/projects`, /\/api\/v1\/projects/, 'fail500');
  await probe(
    page,
    'owners list — BE down (abort)',
    `${WEB}/he/owners`,
    /\/api\/v1\/owners/,
    'abort',
  );
  await probe(
    page,
    'signature-requests — 500',
    `${WEB}/he/signature-requests`,
    /\/api\/v1\/signature-requests/,
    'fail500',
  );
  writeFileSync(join(OUT, 'error-handling.json'), JSON.stringify(results, null, 2));
  for (const r of results)
    console.log(
      `[err] ${r.scenario.padEnd(38)} hebrewErr=${r.hasHebrewError} retry=${r.hasRetry} blank=${r.looksBlank} crashed=${r.crashed}`,
    );
  expect(results.length).toBe(4);
});

test('error UX: detail page for non-existent id (404)', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message.slice(0, 120)));
  await page.goto(`${WEB}/he/projects/00000000-0000-0000-0000-000000000000`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(3000);
  const bodyText =
    (await page
      .locator('body')
      .innerText()
      .catch(() => '')) || '';
  const rec = {
    scenario: 'project detail — bogus id (404)',
    hasHebrewError: /שגיא|נכשל|לא נמצא|בעיה|נסה/.test(bodyText),
    looksBlank: bodyText.trim().length < 40,
    crashed: consoleErrors.length > 0,
    bodySample: bodyText.replace(/\s+/g, ' ').slice(0, 180),
  };
  results.push(rec);
  writeFileSync(join(OUT, 'error-handling.json'), JSON.stringify(results, null, 2));
  console.log(
    `[err] ${rec.scenario} hebrewErr=${rec.hasHebrewError} blank=${rec.looksBlank} crashed=${rec.crashed}`,
  );
  expect(true).toBeTruthy();
});
