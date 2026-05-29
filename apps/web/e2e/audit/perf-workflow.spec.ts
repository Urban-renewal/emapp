import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, WEB } from './_helpers';

/**
 * PERF — real workflow, wall-clock + round-trip waterfall per navigation.
 * Logs in fresh (manager), then navigates the daily flow, measuring for each
 * step: wall-clock click→settled(networkidle), the /api/v1 calls fired
 * (count, durations, and whether they OVERLAP = parallel vs run back-to-back
 * = sequential waterfall), and time to first API response.
 * Output: docs/audit/artifacts/perf/workflow.json
 */
const OUT = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'perf');
mkdirSync(OUT, { recursive: true });

test.describe.configure({ timeout: 120_000 });

interface ApiCall {
  url: string;
  start: number;
  end: number;
  dur: number;
  status: number;
}

test('workflow timing breakdown (manager, Alpha)', async ({ page }) => {
  const steps: any[] = [];
  let calls: ApiCall[] = [];
  const t0 = () => Date.now();
  const starts = new Map<string, number>();
  page.on('request', (r) => {
    if (r.url().includes('/api/v1')) starts.set(r.url() + r.method(), Date.now());
  });
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/v1')) return;
    const k = u + r.request().method();
    const s = starts.get(k) ?? Date.now();
    calls.push({
      url: u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*/, ''),
      start: s,
      end: Date.now(),
      dur: Date.now() - s,
      status: r.status(),
    });
  });

  async function measure(label: string, action: () => Promise<void>) {
    calls = [];
    const start = t0();
    await action();
    await page.waitForLoadState('networkidle').catch(() => {});
    const settledMs = t0() - start;
    // waterfall analysis: are api calls overlapping (parallel) or back-to-back (sequential)?
    const api = [...calls].sort((a, b) => a.start - b.start);
    let maxConcurrent = 0;
    for (let i = 0; i < api.length; i++) {
      const overlaps = api.filter((c) => c.start < api[i]!.end && c.end > api[i]!.start).length;
      maxConcurrent = Math.max(maxConcurrent, overlaps);
    }
    const firstApi = api[0] ? api[0].start - start : null;
    steps.push({
      step: label,
      settledMs,
      apiCount: api.length,
      maxConcurrent,
      pattern: api.length <= 1 ? 'single' : maxConcurrent >= 2 ? 'parallel' : 'SEQUENTIAL',
      firstApiAfterMs: firstApi,
      apiSpanMs: api.length ? api[api.length - 1]!.end - api[0]!.start : 0,
      calls: api.map((c) => ({ url: c.url, dur: c.dur, status: c.status })),
    });
  }

  // login (fresh)
  await measure('login→dashboard', async () => {
    await page.goto(`${WEB}/he/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.fill('#email', 'manager@alpha.dev');
    await page.fill('#password', 'DevPassword123!');
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 }),
      page.click('button[type=submit]'),
    ]);
  });

  // WARM every route once (Next dev compiles on first hit — not representative).
  for (const r of [
    '/he/projects',
    '/he/owners',
    '/he/documents',
    '/he/signature-requests',
    '/he/audit',
    '/he',
  ]) {
    await page.goto(`${WEB}${r}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.goto(`${WEB}/he`, { waitUntil: 'networkidle' }).catch(() => {});

  await measure('→ projects list', async () => {
    await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
  });
  // open first project via its card link
  await measure('→ open first project', async () => {
    const card = page.locator('a[href*="/projects/"]').first();
    await card.click().catch(() => {});
  });
  await measure('→ owners list', async () => {
    await page.goto(`${WEB}/he/owners`, { waitUntil: 'domcontentloaded' });
  });
  await measure('→ documents list', async () => {
    await page.goto(`${WEB}/he/documents`, { waitUntil: 'domcontentloaded' });
  });
  await measure('→ signature-requests', async () => {
    await page.goto(`${WEB}/he/signature-requests`, { waitUntil: 'domcontentloaded' });
  });
  await measure('→ audit log', async () => {
    await page.goto(`${WEB}/he/audit`, { waitUntil: 'domcontentloaded' });
  });

  // client-side SPA nav (clicking sidebar) vs full goto — measure one
  await measure('SPA nav: sidebar → projects', async () => {
    await page.goto(`${WEB}/he`, { waitUntil: 'networkidle' });
    await page
      .locator('a[href$="/projects"], a[href*="/projects"]')
      .first()
      .click()
      .catch(() => {});
  });

  writeFileSync(join(OUT, 'workflow.json'), JSON.stringify(steps, null, 2));
  for (const s of steps)
    console.log(
      `[perf] ${s.step.padEnd(30)} settled=${s.settledMs}ms api=${s.apiCount}(${s.pattern}) span=${s.apiSpanMs}ms`,
    );
  expect(steps.length).toBeGreaterThan(0);
});
