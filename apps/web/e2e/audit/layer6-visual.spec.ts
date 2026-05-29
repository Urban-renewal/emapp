import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, WEB } from './_helpers';

/**
 * VISUAL PASS — capture key screens for RTL/spacing eyeballing, and resolve
 * the open Layer-2 question: does the owner FE form fail for a REAL human
 * (slow typing after full hydration) or only under fast automation?
 */
const SHOTS = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'shots');
mkdirSync(SHOTS, { recursive: true });
const OUT = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'layer6');
mkdirSync(OUT, { recursive: true });

test.describe('visual', () => {
  test.use({ storageState: join(__dirname, '.auth', 'manager.json') });

  test('screenshots of key screens (RTL/spacing)', async ({ page }) => {
    const screens: [string, string][] = [
      ['dashboard-home', `${WEB}/he`],
      ['projects-list', `${WEB}/he/projects`],
      ['owner-detail-bidi', `${WEB}/he/owners/e776ee5e-9b41-4507-af07-457de3d5cb2a`],
      ['signature-requests', `${WEB}/he/signature-requests`],
      ['settings', `${WEB}/he/settings`],
    ];
    for (const [name, url] of screens) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
    }
    expect(true).toBeTruthy();
  });

  test('owner form — human-like slow typing (resolve hydration-race question)', async ({
    page,
  }) => {
    const ev: Record<string, unknown> = {};
    const name = `audit-human-${Date.now()}`;
    const nid = (() => {
      const b = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10));
      let s = 0;
      b.forEach((d, i) => {
        let v = d * ((i % 2) + 1);
        if (v > 9) v -= 9;
        s += v;
      });
      return b.join('') + String((10 - (s % 10)) % 10);
    })();
    await page.goto(`${WEB}/he/owners/new`, { waitUntil: 'domcontentloaded' });
    await page.locator('#name').waitFor({ state: 'visible' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500); // generous hydration window
    // Type like a human: focus + keystroke-by-keystroke.
    await page.locator('#name').click();
    await page.locator('#name').pressSequentially(name, { delay: 30 });
    await page.locator('#national_id').click();
    await page.locator('#national_id').pressSequentially(nid, { delay: 30 });
    await page.locator('#phone').click();
    await page.locator('#phone').pressSequentially('0521234567', { delay: 30 });
    const post = page.waitForResponse(
      (r) => r.url().includes('/api/v1/owners') && r.request().method() === 'POST',
      { timeout: 12_000 },
    );
    await page.locator('button[type=submit]').click();
    let status = 0;
    try {
      status = (await post).status();
    } catch {
      /* */
    }
    ev.humanTypingPostStatus = status;
    ev.landedDetail = /\/owners\/[0-9a-f-]{36}/.test(page.url());
    ev.validationErrorsShown = (
      await page
        .locator('.text-destructive')
        .allInnerTexts()
        .catch(() => [])
    ).filter(Boolean);
    ev.verdict =
      status === 201
        ? 'FE FORM WORKS for human typing (automation-only race)'
        : `FE FORM STILL FAILS (post=${status}) — real bug`;
    writeFileSync(join(OUT, 'owner-form-human.json'), JSON.stringify(ev, null, 2));
    // record but don't hard-fail (diagnostic)
    expect(true).toBeTruthy();
  });
});
