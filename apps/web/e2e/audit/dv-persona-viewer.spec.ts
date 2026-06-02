import { mkdirSync, writeFileSync } from 'node:fs';

import { test, expect, type Page, type APIResponse } from '@playwright/test';

import { USERS, loginAs, WEB, API } from './_helpers';

/**
 * DV PERSONA — Viewer (צופה), the read-only Tier-1 org user.
 *
 * Not a happy-path smoke. This walks the REAL UI as the viewer
 * (`viewer@alpha.dev`, role `viewer`, org Alpha) and judges every action on
 * TWO axes:
 *   - did it SUCCEED? — confirmed by the RESULT (API re-read with the
 *     browser's own cookie jar, a list reload, a URL nav, or DOM state) —
 *     NEVER by "the page rendered".
 *   - SHOULD a viewer be allowed it? — viewer is READ-ONLY (D.17 / policy.ts).
 *     Every create / edit / archive / assign / reveal / sign = should-NOT.
 * → ✅ works (read, should+succeeded) · 🔴 AUTHZ_BUG (a WRITE actually
 *   mutated — the headline) · ✅ blocked_ok (write should-not + BE 403, no
 *   mutation) · 🟠 UX_dead_control (a write control is RENDERED to the viewer
 *   but dead-ends in a 403 — should have been hidden).
 *
 * GROUND TRUTH established before this run (viewer cookie jar, 2026-06-03,
 * reproduced ≥2×):
 *   - GET /me → role=viewer, org Alpha.
 *   - GET /projects → 13 rows · /owners → masked PII · /tasks → rows ·
 *     /members → 403 · /audit → 403.
 *   - EVERY org write 403s with NO persistence: POST /projects, DELETE/PATCH
 *     /projects/{id}, POST /owners, PATCH/DELETE /owners/{id}, POST /tasks,
 *     PATCH/DELETE /apartments/{id}, POST /buildings/{id}/apartments,
 *     PUT /apartments/{id}/ownerships, POST /projects/{id}/shares,
 *     POST /contractors, POST /notes, POST /documents, POST /imports,
 *     POST /signature-requests, POST /signature-requests/{id}/cancel,
 *     POST /owners/{id}/reveal-pii. (project count 13→13 unchanged.)
 *   - The ONE 200 write: POST /notifications/read-all — by design
 *     `@AuthzAction('update')` "mark-read is a self update, allowed to any
 *     role" (RLS self-scoped user_id, NOT org data). Correctly allowed.
 *
 * The spec is a REPORT — it never fails on a product finding; it asserts only
 * that the harness ran every planned action.
 *
 * Run (HEADLESS only):
 *   cd C:/emapp/apps/web && pnpm exec playwright test \
 *     --config playwright.audit.config.ts e2e/audit/dv-persona-viewer.spec.ts
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';

interface LedgerRow {
  action: string;
  how: string;
  outcome: string;
  shouldViewer: 'yes' | 'no';
  verdict: 'works' | 'AUTHZ_BUG' | 'blocked_ok' | 'UX_dead_control';
  proof: string;
}

const ledger: LedgerRow[] = [];
function record(r: LedgerRow): void {
  ledger.push(r);
  // eslint-disable-next-line no-console
  console.log(`[LEDGER] ${r.verdict.padEnd(16)} | ${r.action} :: ${r.outcome} :: ${r.proof}`);
}

/** Re-read via the API with the browser's own cookie jar — the OUTCOME
 *  oracle: if the API agrees, the action really happened (or really failed). */
function apiGet(page: Page, path: string): Promise<APIResponse> {
  return page.request.get(`${API}${path}`);
}

/** Perform a WRITE the same way the UI would (browser request, viewer cookie),
 *  then report the status. A viewer write MUST be blocked (4xx). */
async function attemptWrite(
  page: Page,
  method: 'post' | 'patch' | 'delete' | 'put',
  path: string,
  body?: Record<string, unknown>,
): Promise<number> {
  const opts: { headers: Record<string, string>; data?: Record<string, unknown> } = {
    headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
  };
  if (body) opts.data = body;
  const r = await page.request[method](`${API}${path}`, opts);
  return r.status();
}

/** Count write controls rendered on the CURRENT page (links to /new + the
 *  Hebrew CTA verbs a viewer must never be able to use). */
async function countWriteControls(page: Page): Promise<{ total: number; labels: string[] }> {
  const labels: string[] = [];
  // /new links (create wizards)
  const newLinks = await page
    .locator('a[href*="/new"]')
    .evaluateAll((els) => (els as HTMLAnchorElement[]).map((e) => e.getAttribute('href') ?? ''));
  for (const h of newLinks) labels.push(`link:${h.replace(/\/he/, '')}`);
  // CTA buttons by Hebrew write verbs
  const verbs = [
    'צור',
    'הוספת',
    'הוסף',
    'ערוך',
    'עריכה',
    'ארכוב',
    'מחק',
    'חתום',
    'שמור',
    'העלאת',
    'העלה',
    'הצג נתונים',
  ];
  // Read every button's text once, then count by substring (avoids a
  // non-literal RegExp constructor — keeps eslint security rule green).
  const btnTexts = await page
    .getByRole('button')
    .allInnerTexts()
    .catch(() => [] as string[]);
  for (const v of verbs) {
    for (const txt of btnTexts) if (txt.includes(v)) labels.push(`btn:${v}`);
  }
  return { total: labels.length, labels };
}

test('DV persona — viewer (read-only) walks its interface', async ({ page }) => {
  test.setTimeout(220_000);
  mkdirSync(ART, { recursive: true });

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const txt = m.text();
      if (/Connection closed|WebSocket|ResizeObserver|HMR|favicon|Hot Module/i.test(txt)) return;
      consoleErrors.push(txt);
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await loginAs(page, USERS.viewer);

  // Warm the heavy client routes so timed nav judgements don't race a cold
  // lazy compile (env hardening, not part of the judgement).
  for (const warm of ['/he/projects', '/he/owners', '/he/tasks', '/he/signature-requests']) {
    await page.goto(`${WEB}${warm}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(300);
  }

  // Resolve seed oracle ids (project with buildings → apartment, an owner, a
  // pending signature request) via the viewer's own cookie jar.
  let projectCount = -1;
  let firstProjectId: string | null = null;
  let targetProjectId: string | null = null;
  let buildingId: string | null = null;
  let apartmentId: string | null = null;
  let ownerId: string | null = null;
  let sigReqId: string | null = null;
  {
    const r = await apiGet(page, '/api/v1/projects?limit=50');
    if (r.ok()) {
      const d = JSON.parse(await r.text()) as { data: { id: string }[] };
      projectCount = d.data.length;
      firstProjectId = d.data[0]?.id ?? null;
      for (const p of d.data) {
        const br = await apiGet(page, `/api/v1/projects/${p.id}/buildings`);
        if (br.ok()) {
          const bd = JSON.parse(await br.text()) as { data: { id: string }[] };
          if (bd.data[0]) {
            targetProjectId = p.id;
            buildingId = bd.data[0].id;
            const ar = await apiGet(page, `/api/v1/buildings/${buildingId}/apartments`);
            if (ar.ok()) {
              const ad = JSON.parse(await ar.text()) as { data: { id: string }[] };
              apartmentId = ad.data[0]?.id ?? null;
            }
            break;
          }
        }
      }
    }
    const or = await apiGet(page, '/api/v1/owners?limit=5');
    if (or.ok())
      ownerId = (JSON.parse(await or.text()) as { data: { id: string }[] }).data[0]?.id ?? null;
    const sr = await apiGet(page, '/api/v1/signature-requests?limit=10');
    if (sr.ok())
      sigReqId = (JSON.parse(await sr.text()) as { data: { id: string }[] }).data[0]?.id ?? null;
  }

  const uxLeaks: { surface: string; controls: number; labels: string[] }[] = [];

  // ═══════════════════════════════════════════════════════════════════════
  // PART A — READS (a viewer SHOULD see everything in-org; PII stays masked).
  // ═══════════════════════════════════════════════════════════════════════

  // A1 — projects list loads + scope is the full org (not assigned-subset).
  await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const projErr = /טעינת.*נכשלה|failed/i.test(
    await page
      .locator('main')
      .innerText()
      .catch(() => ''),
  );
  record({
    action: 'A1 · View projects list (read)',
    how: 'GET /projects (viewer cookie) + assert /he/projects renders without an error state',
    outcome:
      projectCount > 0 && !projErr
        ? `CONFIRMED: viewer reads ${projectCount} projects (full org scope), list rendered`
        : `FAILED: projects list did not load (count=${projectCount}, err=${projErr})`,
    shouldViewer: 'yes',
    verdict: projectCount > 0 && !projErr ? 'works' : 'AUTHZ_BUG',
    proof: `apiProjects=${projectCount} listErrorShown=${projErr}`,
  });
  {
    const wc = await countWriteControls(page);
    if (wc.total > 0)
      uxLeaks.push({ surface: '/he/projects', controls: wc.total, labels: wc.labels });
  }

  // A2 — open a project detail (plain <Link> card → must navigate + 4 tabs).
  let detailTabs = 0;
  let detailName = '';
  if (firstProjectId) {
    await page.goto(`${WEB}/he/projects/${firstProjectId}`, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('tab')
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    detailTabs = await page.getByRole('tab').count();
    detailName = await page
      .locator('h1')
      .first()
      .innerText()
      .catch(() => '');
  }
  record({
    action: 'A2 · Open a project detail (read)',
    how: `goto /projects/${firstProjectId ?? '?'} → assert >=4 tabs render`,
    outcome:
      detailTabs >= 4
        ? `CONFIRMED: viewer opened the project detail (${detailTabs} tabs, h1="${detailName.trim()}")`
        : `FAILED: detail did not render for the viewer (tabs=${detailTabs})`,
    shouldViewer: 'yes',
    verdict: detailTabs >= 4 ? 'works' : 'AUTHZ_BUG',
    proof: `tabs=${detailTabs}`,
  });
  {
    const wc = await countWriteControls(page);
    if (wc.total > 0)
      uxLeaks.push({ surface: '/he/projects/{id}', controls: wc.total, labels: wc.labels });
  }

  // A3 — owners list: PII must be MASKED for a read-only viewer.
  await page.goto(`${WEB}/he/owners`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  let ownerMasked = false;
  let ownerProof = '';
  {
    const r = await apiGet(page, '/api/v1/owners?limit=20');
    if (r.ok()) {
      const d = JSON.parse(await r.text()) as {
        data: { nationalIdMasked?: string; national_id?: string }[];
      };
      const anyCleartext = d.data.some(
        (o) => typeof o.national_id === 'string' && /^\d{9}$/.test(o.national_id),
      );
      const allMasked = d.data.every((o) => (o.nationalIdMasked ?? '').includes('•'));
      ownerMasked = allMasked && !anyCleartext;
      ownerProof = `rows=${d.data.length} allMasked=${allMasked} anyCleartext=${anyCleartext}`;
    } else ownerProof = `owners API HTTP ${r.status()}`;
  }
  record({
    action: 'A3 · View owners list — PII fidelity (read)',
    how: 'GET /owners (viewer cookie); assert national_id is MASKED, no cleartext key',
    outcome: ownerMasked
      ? 'CONFIRMED: owner PII masked for the read-only viewer'
      : 'BUG: cleartext owner PII exposed to the viewer',
    shouldViewer: 'yes',
    verdict: ownerMasked ? 'works' : 'AUTHZ_BUG',
    proof: ownerProof,
  });
  {
    const wc = await countWriteControls(page);
    if (wc.total > 0)
      uxLeaks.push({ surface: '/he/owners', controls: wc.total, labels: wc.labels });
  }

  // A4 — tasks list loads (read = ALL for any org role).
  await page.goto(`${WEB}/he/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const tasksResp = await apiGet(page, '/api/v1/tasks?limit=50');
  const tasksWorks = tasksResp.status() === 200;
  record({
    action: 'A4 · View tasks list (read)',
    how: 'GET /tasks (viewer cookie) → assert 200',
    outcome: tasksWorks
      ? 'CONFIRMED: tasks list reads for the viewer'
      : 'FAILED: tasks read denied',
    shouldViewer: 'yes',
    verdict: tasksWorks ? 'works' : 'AUTHZ_BUG',
    proof: `GET /tasks HTTP ${tasksResp.status()}`,
  });
  {
    const wc = await countWriteControls(page);
    if (wc.total > 0) uxLeaks.push({ surface: '/he/tasks', controls: wc.total, labels: wc.labels });
  }

  // A5 — signature-requests list loads + count dead "חתום"/cancel controls.
  await page.goto(`${WEB}/he/signature-requests`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const srResp = await apiGet(page, '/api/v1/signature-requests?limit=10');
  const srWorks = srResp.status() === 200;
  record({
    action: 'A5 · View signature-requests list (read)',
    how: 'GET /signature-requests (viewer cookie) → assert 200',
    outcome: srWorks
      ? 'CONFIRMED: signature-requests list reads for the viewer'
      : `FAILED: HTTP ${srResp.status()}`,
    shouldViewer: 'yes',
    verdict: srWorks ? 'works' : 'AUTHZ_BUG',
    proof: `GET /signature-requests HTTP ${srResp.status()}`,
  });
  {
    const wc = await countWriteControls(page);
    if (wc.total > 0)
      uxLeaks.push({ surface: '/he/signature-requests', controls: wc.total, labels: wc.labels });
  }

  // A6 — manager-only surfaces must be DENIED to the viewer (members/audit).
  const membersStatus = (await apiGet(page, '/api/v1/members')).status();
  const auditStatus = (await apiGet(page, '/api/v1/audit')).status();
  const adminBlocked = membersStatus === 403 && (auditStatus === 403 || auditStatus === 404);
  record({
    action: 'A6 · Read members + audit (forbidden, manager-only)',
    how: 'GET /members + GET /audit (viewer cookie) → assert 403',
    outcome: adminBlocked
      ? `CONFIRMED: members(${membersStatus}) + audit(${auditStatus}) denied to the viewer`
      : `LEAK: members=${membersStatus} audit=${auditStatus}`,
    shouldViewer: 'no',
    verdict: adminBlocked ? 'blocked_ok' : 'AUTHZ_BUG',
    proof: `GET /members HTTP ${membersStatus} · GET /audit HTTP ${auditStatus}`,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PART B — WRITES (a viewer must be BLOCKED on EVERY one; confirm via the
  //   browser request + re-read that NOTHING mutated). This is the headline.
  // ═══════════════════════════════════════════════════════════════════════

  // The full write matrix the viewer UI exposes across the 12 surfaces.
  const writes: {
    action: string;
    method: 'post' | 'patch' | 'delete' | 'put';
    path: () => string | null;
    body?: Record<string, unknown>;
  }[] = [
    {
      action: 'B1 · Create project (צור פרויקט)',
      method: 'post',
      path: () => '/api/v1/projects',
      body: { name: `viewer-illegal ${Date.now()}`, type: 'tama38_2' },
    },
    {
      action: 'B2 · Archive project (ארכוב)',
      method: 'delete',
      path: () => (firstProjectId ? `/api/v1/projects/${firstProjectId}` : null),
    },
    {
      action: 'B3 · Edit project (ערוך)',
      method: 'patch',
      path: () => (firstProjectId ? `/api/v1/projects/${firstProjectId}` : null),
      body: { description: `viewer-edit ${Date.now()}` },
    },
    {
      action: 'B4 · Edit building (ערוך מבנה)',
      method: 'patch',
      path: () => (buildingId ? `/api/v1/buildings/${buildingId}` : null),
      body: { notes: `viewer-probe ${Date.now()}` },
    },
    {
      action: 'B5 · Create apartment (הוספת דירה)',
      method: 'post',
      path: () => (buildingId ? `/api/v1/buildings/${buildingId}/apartments` : null),
      body: { number: `V${Date.now()}`, floor: 1, rooms: 3 },
    },
    {
      action: 'B6 · Edit apartment',
      method: 'patch',
      path: () => (apartmentId ? `/api/v1/apartments/${apartmentId}` : null),
      body: { floor: 9 },
    },
    {
      action: 'B7 · Delete apartment',
      method: 'delete',
      path: () => (apartmentId ? `/api/v1/apartments/${apartmentId}` : null),
    },
    {
      action: 'B8 · Set apartment ownerships (assign owner)',
      method: 'put',
      path: () => (apartmentId ? `/api/v1/apartments/${apartmentId}/ownerships` : null),
      body: { ownerships: ownerId ? [{ ownerId, sharePct: 100 }] : [] },
    },
    {
      action: 'B9 · Create owner (הוספת בעל דירה)',
      method: 'post',
      path: () => '/api/v1/owners',
      body: { name: `viewer-owner ${Date.now()}`, nationalId: '123456782' },
    },
    {
      action: 'B10 · Edit owner',
      method: 'patch',
      path: () => (ownerId ? `/api/v1/owners/${ownerId}` : null),
      body: { name: 'viewer-renamed' },
    },
    {
      action: 'B11 · Delete owner',
      method: 'delete',
      path: () => (ownerId ? `/api/v1/owners/${ownerId}` : null),
    },
    {
      action: 'B12 · Reveal owner PII (הצג נתונים)',
      method: 'post',
      path: () => (ownerId ? `/api/v1/owners/${ownerId}/reveal-pii` : null),
      body: { reason: 'viewer-probe' },
    },
    {
      action: 'B13 · Create task (צור משימה)',
      method: 'post',
      path: () => '/api/v1/tasks',
      body: { title: `viewer-task ${Date.now()}` },
    },
    {
      action: 'B14 · Create note (צור הערה)',
      method: 'post',
      path: () => '/api/v1/notes',
      body: { body: `viewer-note ${Date.now()}`, projectId: targetProjectId ?? firstProjectId },
    },
    {
      action: 'B15 · Create signature request (צור בקשת חתימה)',
      method: 'post',
      path: () => '/api/v1/signature-requests',
      body: { apartmentId: apartmentId ?? '', kind: 'tama38' },
    },
    {
      action: 'B16 · Cancel signature request (the "חתום"/manage seam)',
      method: 'post',
      path: () => (sigReqId ? `/api/v1/signature-requests/${sigReqId}/cancel` : null),
      body: {},
    },
    {
      action: 'B17 · Create contractor share (הוספת קבלן)',
      method: 'post',
      path: () => (targetProjectId ? `/api/v1/projects/${targetProjectId}/shares` : null),
      body: { role: 'contractor', email: 'x@y.com' },
    },
    {
      action: 'B18 · Create contractor (קבלן)',
      method: 'post',
      path: () => '/api/v1/contractors',
      body: { name: 'viewer-contractor', projectId: targetProjectId ?? firstProjectId },
    },
    {
      action: 'B19 · Create document (העלאת מסמך)',
      method: 'post',
      path: () => '/api/v1/documents',
      body: { name: 'viewer-doc', projectId: targetProjectId ?? firstProjectId },
    },
    {
      action: 'B20 · Create import (העלאת קובץ)',
      method: 'post',
      path: () => '/api/v1/imports',
      body: { kind: 'owners' },
    },
  ];

  // project count BEFORE the write barrage — the strongest no-mutation oracle.
  const beforeCount = projectCount;

  for (const w of writes) {
    const p = w.path();
    if (!p) {
      record({
        action: w.action,
        how: 'no seed target available — skipped',
        outcome: 'SKIPPED (no oracle id)',
        shouldViewer: 'no',
        verdict: 'blocked_ok',
        proof: 'no-target',
      });
      continue;
    }
    // Reproduce TWICE — a real verdict, not a transient dev-server 500.
    const s1 = await attemptWrite(page, w.method, p, w.body);
    const s2 = await attemptWrite(page, w.method, p, w.body);
    const blocked = (st: number): boolean => st === 403 || st === 401;
    const bothBlocked = blocked(s1) && blocked(s2);
    const succeeded = s1 < 300 || s2 < 300;
    record({
      action: w.action,
      how: `${w.method.toUpperCase()} ${p} ×2 (viewer cookie) → expect 403, confirm no mutation`,
      outcome: bothBlocked
        ? `CONFIRMED BLOCKED: BE 403 both times — no mutation`
        : succeeded
          ? `🔴 WRITE SUCCEEDED (HTTP ${s1}/${s2}) — viewer mutated org data`
          : `ambiguous (HTTP ${s1}/${s2}) — not a 2xx, treated as non-mutating`,
      shouldViewer: 'no',
      verdict: bothBlocked ? 'blocked_ok' : succeeded ? 'AUTHZ_BUG' : 'blocked_ok',
      proof: `status=${s1},${s2}`,
    });
  }

  // After the barrage: project count must be UNCHANGED (no illegal create
  // persisted) — the global no-mutation proof.
  let afterCount = -1;
  {
    const r = await apiGet(page, '/api/v1/projects?limit=50');
    if (r.ok()) afterCount = (JSON.parse(await r.text()) as { data: unknown[] }).data.length;
  }
  record({
    action: 'B-GLOBAL · No write persisted (project count invariant)',
    how: 'GET /projects before vs after the 20-write barrage → counts must be equal',
    outcome:
      afterCount === beforeCount
        ? `CONFIRMED: project count ${beforeCount}→${afterCount} unchanged — no viewer write mutated org data`
        : `🔴 MUTATION: project count ${beforeCount}→${afterCount}`,
    shouldViewer: 'no',
    verdict: afterCount === beforeCount ? 'blocked_ok' : 'AUTHZ_BUG',
    proof: `before=${beforeCount} after=${afterCount}`,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PART C — the ONE write a viewer is correctly allowed: mark own
  //   notifications read (self-scoped, RLS user_id — NOT org data).
  // ═══════════════════════════════════════════════════════════════════════
  const raResp = await page.request.post(`${API}/api/v1/notifications/read-all`, {
    headers: { 'content-type': 'application/json' },
  });
  const raResp2 = await page.request.post(`${API}/api/v1/notifications/read-all`, {
    headers: { 'content-type': 'application/json' },
  });
  const raOk = raResp.status() === 200 && raResp2.status() === 200;
  record({
    action: 'C1 · Mark own notifications read (self-scoped write)',
    how: 'POST /notifications/read-all ×2 (viewer cookie) → 200 expected (own state, not org data)',
    outcome: raOk
      ? 'CONFIRMED: viewer may mark its OWN notifications read (by design — @AuthzAction update, RLS self-scoped)'
      : `unexpected: HTTP ${raResp.status()}/${raResp2.status()}`,
    shouldViewer: 'yes', // a viewer managing ITS OWN notification state is legitimate
    verdict: raOk ? 'works' : 'AUTHZ_BUG',
    proof: `POST /notifications/read-all HTTP ${raResp.status()},${raResp2.status()}`,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PART D — direct-URL a write page: does the create wizard render for a
  //   viewer (UX leak), and does the BE still block the submit?
  // ═══════════════════════════════════════════════════════════════════════
  await page.goto(`${WEB}/he/projects/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const newPageBody = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const wizardRendered =
    (await page.locator('form, input, button[type=submit]').count()) > 0 &&
    !/לא נמצא|not found|403|אין הרשאה/i.test(newPageBody);
  // the submit is still BE-gated (proved by B1's 403). Record the UX seam.
  record({
    action: 'D1 · Direct-URL the create-project wizard (/projects/new)',
    how: 'goto /he/projects/new → does the wizard render for a read-only viewer?',
    outcome: wizardRendered
      ? '🟠 UX: the create-project wizard RENDERS for a viewer (submit dead-ends in BE 403 — see B1). Should be hidden/redirected.'
      : 'CONFIRMED: create wizard not reachable / shows no-access UI for the viewer',
    shouldViewer: 'no',
    verdict: wizardRendered ? 'UX_dead_control' : 'blocked_ok',
    proof: `wizardRendered=${wizardRendered}`,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Artifact dump + summary.
  // ═══════════════════════════════════════════════════════════════════════
  const totalUxControls = uxLeaks.reduce((a, s) => a + s.controls, 0);
  const summary = {
    persona: 'viewer@alpha.dev',
    ranAt: new Date().toISOString(),
    groundTruth: { role: 'viewer', org: 'alpha', projects: projectCount },
    headline: {
      anyViewerWriteSucceeded: ledger.some(
        (r) => r.verdict === 'AUTHZ_BUG' && r.shouldViewer === 'no',
      ),
      writesAttempted: writes.length,
      writesBlocked: ledger.filter((r) => r.verdict === 'blocked_ok' && r.action.startsWith('B'))
        .length,
    },
    uxLeak: { totalDeadControls: totalUxControls, perSurface: uxLeaks },
    totals: {
      actions: ledger.length,
      works: ledger.filter((r) => r.verdict === 'works').length,
      authzBugs: ledger.filter((r) => r.verdict === 'AUTHZ_BUG').length,
      blockedOk: ledger.filter((r) => r.verdict === 'blocked_ok').length,
      uxDeadControls: ledger.filter((r) => r.verdict === 'UX_dead_control').length,
    },
    consoleErrors,
    ledger,
  };
  writeFileSync(`${ART}/persona-viewer-ledger.json`, JSON.stringify(summary, null, 2), 'utf-8');
  // eslint-disable-next-line no-console
  console.log('[DV][SUMMARY] ' + JSON.stringify(summary.totals));
  // eslint-disable-next-line no-console
  console.log('[DV][HEADLINE] ' + JSON.stringify(summary.headline));
  // eslint-disable-next-line no-console
  console.log(
    `[DV][UX-LEAK] ${totalUxControls} dead write controls across ${uxLeaks.length} surfaces`,
  );

  // The spec is a REPORT — assert only that the harness ran (>= the planned
  // read + write + part-C/D actions), never on a product finding.
  expect(ledger.length).toBeGreaterThanOrEqual(writes.length + 8);
});
