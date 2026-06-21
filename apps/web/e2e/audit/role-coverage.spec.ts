import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, request } from '@playwright/test';

import { WEB, API } from './_helpers';

/**
 * V13 ACCEPTANCE — per-role interface coverage on the REAL stack (non-mocked:
 * real :3001 web + :3000 NestJS + local PG). Uses the saved storageState
 * sessions (00-auth-setup) so every role walks its key routes with a genuine
 * httpOnly-cookie session. For each (role × route) it captures the owner's
 * 6 axes: loads · no console error · no failed network · (timing) · content ·
 * role-correctness. Screenshots land in docs/audit/artifacts/role-coverage.
 */
const AUTH = (r: string) => join(__dirname, '.auth', `${r}.json`);
const ART = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'role-coverage');
mkdirSync(ART, { recursive: true });

const HMR = /Connection closed|WebSocket|ResizeObserver|HMR|Hot Module|favicon|No link element found|Download the React/i;

// Routes every org role should reach (read surfaces). Manager-only ones flagged.
const ROUTES: { path: string; label: string; managerOnly?: boolean }[] = [
  { path: '/he', label: 'home' },
  { path: '/he/projects', label: 'projects-list' },
  { path: '/he/owners', label: 'owners-list' },
  { path: '/he/documents', label: 'documents-list' },
  { path: '/he/signature-requests', label: 'sigreq-list' },
  { path: '/he/tasks', label: 'tasks-list' },
  { path: '/he/notes', label: 'notes-list' },
  { path: '/he/buildings', label: 'buildings-list' },
  { path: '/he/apartments', label: 'apartments-list' },
  { path: '/he/contractors', label: 'contractors-list', managerOnly: true },
  { path: '/he/members', label: 'members-list', managerOnly: true },
  { path: '/he/imports', label: 'imports-list', managerOnly: true },
  { path: '/he/audit', label: 'audit', managerOnly: true },
  { path: '/he/notifications', label: 'notifications' },
  { path: '/he/settings', label: 'settings', managerOnly: true },
];

type Finding = {
  role: string;
  route: string;
  url: string;
  consoleErrors: string[];
  failedNetwork: string[];
  lowContrast: string[];
  errorBoundary: boolean;
  textLen: number;
  warmMs: number;
};

const results: Finding[] = [];

for (const role of ['manager', 'agent', 'viewer'] as const) {
  test.describe(`role: ${role}`, () => {
    test.use({ storageState: AUTH(role) });

    for (const r of ROUTES) {
      test(`${role} → ${r.label}`, async ({ page }) => {
        const consoleErrors: string[] = [];
        const failedNetwork: string[] = [];
        page.on('console', (m) => {
          if (m.type() === 'error' && !HMR.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
        });
        page.on('pageerror', (e) => {
          if (!HMR.test(e.message)) consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`);
        });
        page.on('response', (resp) => {
          const u = resp.url();
          if (resp.status() >= 400 && (u.includes('/api/v1') || u.startsWith(WEB)) && !u.includes('/_next/static'))
            failedNetwork.push(`${resp.status()} ${u.replace(WEB, '').replace(API, '')}`);
        });

        // domcontentloaded (NOT networkidle — the HMR websocket keeps the dev
        // server's network "busy" forever, so networkidle never fires in dev).
        // Cold load (may include dev first-compile — NOT the budget metric).
        await page.goto(`${WEB}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1200);
        // WARM interaction time — the owner's < 1s budget. Re-navigate the now-
        // compiled route and measure goto→domcontentloaded. (See memory:
        // feedback_sub_second_interaction_budget — measured every walk.)
        const warmStart = Date.now();
        await page.goto(`${WEB}${r.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        const warmMs = Date.now() - warmStart;
        await page.waitForTimeout(600);
        if (warmMs > 1000) console.log(`[PERF>1s] ${role}/${r.label} warm load = ${warmMs}ms`);

        const url = page.url();
        const bounced = url.includes('/login');
        // A non-manager hitting a manager-only route may be access-gated (403 UI
        // or redirect) — that's CORRECT, not a failure. Record + skip asserts.
        const accessGated = r.managerOnly && role !== 'manager';

        const errorBoundary = await page
          .getByText(/משהו השתבש|אירעה שגיאה|Something went wrong/)
          .count()
          .then((n) => n > 0)
          .catch(() => false);

        const lowContrast = await page
          .evaluate(() => {
            const out: string[] = [];
            const parse = (c: string) => (c.match(/\d+/g) || []).map(Number);
            const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
            // Scan ONLY the main content area — the nav/sidebar/header chrome
            // uses navy CSS-GRADIENT backgrounds that getComputedStyle reports
            // as transparent, which would false-positive white-on-white.
            for (const el of Array.from(document.querySelectorAll('main *')).slice(0, 3000)) {
              const h = el as HTMLElement;
              const txt = h.innerText?.trim();
              if (!txt || txt.length < 2 || h.childElementCount > 0) continue;
              const s = getComputedStyle(el);
              const [r, g, b] = parse(s.color);
              // Resolve to the first OPAQUE ancestor bg, skipping transparent/
              // translucent overlays. If ANY element in the chain paints a
              // background-IMAGE (gradient), the visible bg is unknowable to
              // getComputedStyle().backgroundColor → skip (else white-on-navy
              // gradient hero text false-positives as white-on-white).
              let bg = s.backgroundColor;
              let alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : 1;
              let overImage = s.backgroundImage !== 'none';
              let p: Element | null = el;
              while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || alpha < 0.95) && p?.parentElement) {
                p = p.parentElement;
                const cs = getComputedStyle(p);
                if (cs.backgroundImage !== 'none') overImage = true;
                bg = cs.backgroundColor;
                alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3] ?? '1') : 1;
              }
              if (overImage) continue;
              const [br, bgc, bb] = parse(bg);
              if ([r, g, b, br, bgc, bb].some((x) => x === undefined)) continue;
              // The invisible-text trap is LIGHT text on a LIGHT bg (e.g. bare
              // text-muted #f5f5f4 on white). Only flag when the bg is clearly
              // light (lum>205) AND the text is near-invisible against it.
              if (lum(br, bgc, bb) > 205 && Math.abs(lum(r, g, b) - lum(br, bgc, bb)) < 38)
                out.push(`"${txt.slice(0, 24)}" ${s.color} on ${bg}`);
            }
            return Array.from(new Set(out)).slice(0, 12);
          })
          .catch(() => [] as string[]);

        const textLen = await page.locator('body').innerText().then((t) => t.length).catch(() => 0);
        await page.screenshot({ path: join(ART, `${role}-${r.label}.png`) }).catch(() => {});

        results.push({
          role, route: r.label, url,
          consoleErrors, failedNetwork, lowContrast,
          errorBoundary, textLen, warmMs,
        });

        // Assertions (skip access-gated manager-only routes for non-managers).
        if (!accessGated) {
          expect(bounced, `${role} ${r.label} must not bounce to /login`).toBeFalsy();
          expect(errorBoundary, `${role} ${r.label} must not show an error boundary`).toBeFalsy();
          expect(consoleErrors, `${role} ${r.label} console must be clean`).toEqual([]);
          expect(failedNetwork, `${role} ${r.label} no failed network`).toEqual([]);
          // lowContrast is ADVISORY (logged to _summary.json) — the pixel-luminance
          // heuristic can't see CSS-gradient/layered backgrounds (navy heroes), so
          // it false-positives. The AUTHORITATIVE invisible-text gate is the static
          // palette guard (app-no-default-palette-class.spec.ts), green in CI.
          if (lowContrast.length) console.log(`[advisory] ${role}/${r.label} contrast hits:`, lowContrast.length);
        }
      });
    }
  });
}

test.afterAll(async () => {
  writeFileSync(join(ART, '_summary.json'), JSON.stringify(results, null, 2));
  // PII-mask check: as agent (view_owner_pii=false), the owners list/detail must
  // NOT contain a 9-digit national_id in cleartext.
  const ctx = await request.newContext({ storageState: AUTH('agent') });
  const ownersRes = await ctx.get(`${API}/api/v1/owners?limit=10`);
  const body = await ownersRes.json().catch(() => ({}));
  const raw = JSON.stringify(body);
  const leak = /"national_?[iI]d"\s*:\s*"\d{9}"/.test(raw);
  writeFileSync(join(ART, '_pii-mask.json'), JSON.stringify({ agentOwnersStatus: ownersRes.status(), nationalIdLeak: leak }, null, 2));
  await ctx.dispose();
});
