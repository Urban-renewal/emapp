import { mkdirSync, writeFileSync } from 'node:fs';

import { test, expect, type Page, type APIResponse } from '@playwright/test';

import { USERS, loginAs, WEB, API } from './_helpers';

/**
 * DV PERSONA — Field Agent (סוכן שטח).
 *
 * Not a happy-path smoke. This walks the REAL UI as the agent
 * (`agent@alpha.dev`, role `agent`, org Alpha) and, for every natural
 * field-agent action, judges on two axes:
 *   - did it SUCCEED (confirmed by the RESULT — entity re-read from the API
 *     with the browser's own cookie jar, a list reload, or a URL nav — never
 *     by "the page rendered")?
 *   - SHOULD a field agent be allowed it (per D.17 + D.46 capability model)?
 * → ✅ works · 🔴 FUNCTIONAL_BUG (should+failed) · 🔴 AUTHZ_BUG (should-not+
 *   succeeded) · ✅ blocked_ok (should-not+failed) · UX_dead_click (silent
 *   dead control that should have been hidden).
 *
 * GROUND TRUTH established via the API before this run (agent cookie jar):
 *   - GET /me → role=agent, view_owner_pii=FALSE (this seed agent has NO
 *     capabilities granted — owners show MASKED, edits 403).
 *   - GET /projects → 3 rows (Tama 38/2 Pilot + ארלוזורוב 14 + ויצמן 20).
 *     (The task brief said "2 assigned"; the API + seed show 3.)
 *   - GET /projects/{unassigned} → 404 · POST /projects → 403 ·
 *     GET /members → 403 · GET /audit → 403 · PATCH assigned building → 403.
 * The spec re-confirms each through the BROWSER (the user's real path) and
 * cross-checks via the API oracle.
 *
 * Run (HEADLESS only):
 *   cd C:/emapp/apps/web && pnpm exec playwright test \
 *     --config playwright.audit.config.ts e2e/audit/dv-persona-agent.spec.ts
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';

// Seed oracle (org Alpha, 2026-06-03). The agent is assigned to these 3.
const ASSIGNED_PROJECTS = [
  { id: 'a05e3d48-aaf2-43da-a6ec-6835e224cd4d', name: 'ארלוזורוב 14' },
  { id: 'a82aa653-8f40-4276-b41d-ff0336328cbd', name: 'ויצמן 20' },
  { id: '1ace1c99-19fb-48b5-8bd8-0c0e886b605c', name: 'Pilot' },
];
// A project the agent is NOT assigned to (manager sees it; agent must not).
const UNASSIGNED_PROJECT = '83ca0e95-0f06-415a-ad0e-2fcf59135ad4'; // נווה שאנן (דמו)

interface LedgerRow {
  action: string;
  how: string;
  outcome: string;
  shouldAgent: 'yes' | 'no';
  verdict: 'works' | 'FUNCTIONAL_BUG' | 'AUTHZ_BUG' | 'blocked_ok' | 'UX_dead_click';
  proof: string;
}

const ledger: LedgerRow[] = [];
function record(r: LedgerRow): void {
  ledger.push(r);
  // eslint-disable-next-line no-console
  console.log(`[LEDGER] ${r.verdict.padEnd(15)} | ${r.action} :: ${r.outcome} :: ${r.proof}`);
}

/** Re-read via the API using the browser's own cookie jar — the OUTCOME
 *  oracle: if the API agrees, the action really happened (or really failed). */
async function apiGet(page: Page, path: string): Promise<APIResponse> {
  return page.request.get(`${API}${path}`);
}

/** Click an element and decide whether a CLIENT navigation actually happened.
 *  next/link fires no load event — we poll the URL for a change up to timeout.
 *  Returns the final url + whether it changed AND matched the expected regex. */
async function clickAndAwaitNav(
  page: Page,
  click: () => Promise<void>,
  expectUrl: RegExp,
  timeout = 8000,
): Promise<{ navigated: boolean; url: string }> {
  const before = page.url();
  await click().catch(() => {});
  try {
    await page.waitForURL((u) => u.toString() !== before && expectUrl.test(u.toString()), {
      timeout,
    });
  } catch {
    /* no nav within window */
  }
  const url = page.url();
  return { navigated: url !== before && expectUrl.test(url), url };
}

test('DV persona — field agent walks its interface', async ({ page }) => {
  test.setTimeout(180_000);
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

  await loginAs(page, USERS.agent);

  // Warm-up: force the dev server to compile the heavy client routes so the
  // timed nav judgements below don't race a cold lazy compile (env hardening,
  // NOT part of the persona judgement).
  for (const warm of ['/he/projects', `/he/projects/${ASSIGNED_PROJECTS[0]!.id}`, '/he/owners']) {
    await page.goto(`${WEB}${warm}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(400);
  }

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 1 — SCOPE: the agent must see ONLY its 3 assigned projects, not
  //   all 13 the manager sees. Oracle = API list (browser cookie) + the
  //   rendered card count.
  // ───────────────────────────────────────────────────────────────────────
  await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  let apiProjectCount = -1;
  let apiProjectNames: string[] = [];
  {
    const r = await apiGet(page, '/api/v1/projects?limit=50');
    if (r.ok()) {
      const d = JSON.parse(await r.text()) as { data: { id: string; name: string }[] };
      apiProjectCount = d.data.length;
      apiProjectNames = d.data.map((p) => p.name);
    }
  }
  const renderedCards = await page
    .locator('a[href*="/projects/"]')
    .evaluateAll((els) =>
      (els as HTMLAnchorElement[])
        .map((e) => e.getAttribute('href') ?? '')
        .filter((h) => /\/projects\/[0-9a-f-]{36}$/.test(h)),
    );
  // scope is correct iff the agent sees exactly the assigned set (3) — not the
  // manager's 13. Cards may be ≤ api count (pagination), so judge on the API.
  const scopeOk = apiProjectCount === 3 && apiProjectCount < 13;
  record({
    action: 'See the right project scope (only assigned)',
    how: 'GET /projects (agent cookie) + count rendered project cards; compare vs manager-13',
    outcome: scopeOk
      ? `CONFIRMED: agent sees exactly ${apiProjectCount} assigned projects (manager sees 13)`
      : `UNEXPECTED scope: agent sees ${apiProjectCount} projects`,
    shouldAgent: 'yes',
    verdict: scopeOk ? 'works' : 'AUTHZ_BUG',
    proof: `apiCount=${apiProjectCount} names=[${apiProjectNames.join(', ')}] renderedCards=${renderedCards.length}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 2 — SCOPE (nav): the agent must NOT see Members / Audit / Settings
  //   in the sidebar (manager-only). Oracle = the rendered nav link set.
  // ───────────────────────────────────────────────────────────────────────
  const navTexts = await page
    .locator('aside nav a, aside nav span')
    .allInnerTexts()
    .catch(() => []);
  const forbiddenNav = ['חברי ארגון', 'יומן ביקורת', 'הגדרות']; // members / audit / settings
  const leakedNav = navTexts.filter((n) => forbiddenNav.some((f) => n.includes(f)));
  record({
    action: 'Nav hides manager-only sections (members / audit / settings)',
    how: 'read sidebar nav link texts; assert none of the 3 manager-only labels present',
    outcome:
      leakedNav.length === 0
        ? 'CONFIRMED: members/audit/settings absent from agent nav'
        : `LEAK: agent nav exposes ${leakedNav.join(', ')}`,
    shouldAgent: 'no',
    verdict: leakedNav.length === 0 ? 'blocked_ok' : 'AUTHZ_BUG',
    proof: `nav=[${navTexts
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' | ')}]`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 3 — DRILL-IN: open an ASSIGNED project from the list by clicking
  //   the card (the DV-AGENT-NAV claim: this is a dead no-op for the agent).
  //   Reproduce TWICE: once via the real card click, once via direct URL nav,
  //   to distinguish a true product bug from a selector/hydration artifact.
  // ───────────────────────────────────────────────────────────────────────
  const assignedHref = renderedCards.find((h) => ASSIGNED_PROJECTS.some((p) => h.endsWith(p.id)));
  // 3a — click the card.
  let cardNav = { navigated: false, url: '' };
  if (assignedHref) {
    const card = page.locator(`a[href="${assignedHref}"]`).first();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    cardNav = await clickAndAwaitNav(
      page,
      async () => {
        await card.click();
      },
      /\/he\/projects\/[0-9a-f-]{36}$/,
    );
  }
  // confirm the detail actually rendered (tablist with the 4 project tabs).
  let cardTabs = 0;
  if (cardNav.navigated) {
    await page
      .getByRole('tab')
      .first()
      .waitFor({ state: 'visible', timeout: 8000 })
      .catch(() => {});
    cardTabs = await page.getByRole('tab').count();
  }
  const cardDrillOk = cardNav.navigated && cardTabs >= 4;

  // 3b — direct URL nav to the same assigned project (the "did the detail page
  //   itself work" probe, independent of the card click).
  await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const directProj = ASSIGNED_PROJECTS[0]!;
  await page.goto(`${WEB}/he/projects/${directProj.id}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('tab')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {});
  const directTabs = await page.getByRole('tab').count();
  const directNameShown = (
    await page
      .locator('h1')
      .first()
      .innerText()
      .catch(() => '')
  ).includes(directProj.name);
  const directDrillOk = directTabs >= 4 && directNameShown;

  record({
    action: 'Open an assigned project (card click)',
    how: 'click the assigned project card on /projects → await URL=/projects/{id} + 4 tabs',
    outcome: cardDrillOk
      ? 'CONFIRMED: card click opened the project detail'
      : `${cardNav.navigated ? 'navigated but tabs missing' : 'DEAD CLICK: no navigation'} (url=${cardNav.url.replace(WEB, '')})`,
    shouldAgent: 'yes',
    verdict: cardDrillOk ? 'works' : 'FUNCTIONAL_BUG',
    proof: `cardHref=${assignedHref ?? 'none'} navigated=${cardNav.navigated} tabs=${cardTabs}`,
  });
  record({
    action: 'Open an assigned project (direct URL)',
    how: `goto /projects/${directProj.id} directly → assert 4 tabs + project name in h1`,
    outcome: directDrillOk
      ? 'CONFIRMED: detail page opened for the agent via direct URL'
      : 'FAILED: detail did not render for the agent',
    shouldAgent: 'yes',
    verdict: directDrillOk ? 'works' : 'FUNCTIONAL_BUG',
    proof: `tabs=${directTabs} nameShown=${directNameShown}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 4 — DRILL DEEPER: from the project, reach Buildings → an
  //   apartment. Quantify which drill-ins work vs dead. Uses the dashboard
  //   tab CTA "ניהול דירות/מבנים" then the buildings list.
  // ───────────────────────────────────────────────────────────────────────
  // navigate to the per-project buildings surface (direct, the canonical path).
  await page.goto(`${WEB}/he/projects/${directProj.id}/buildings`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  // API oracle: this project's buildings.
  let buildingId: string | null = null;
  {
    const r = await apiGet(page, `/api/v1/projects/${directProj.id}/buildings`);
    if (r.ok()) {
      const d = JSON.parse(await r.text()) as { data: { id: string }[] };
      buildingId = d.data[0]?.id ?? null;
    }
  }
  // a building row links to /buildings/{uuid}; the "create" CTA is
  // /projects/{id}/buildings/new — match the uuid suffix to skip it.
  let buildingDrillOk = false;
  let buildingNavUrl = '';
  {
    const buildingHrefs = await page
      .locator('a[href*="/buildings/"]')
      .evaluateAll((els) =>
        (els as HTMLAnchorElement[])
          .map((e) => e.getAttribute('href') ?? '')
          .filter((h) => /\/buildings\/[0-9a-f-]{36}$/.test(h)),
      );
    const bHref = buildingHrefs[0];
    const bLink = bHref ? page.locator(`a[href="${bHref}"]`).first() : page.locator('__none__');
    if (bHref && (await bLink.count()) > 0) {
      const r = await clickAndAwaitNav(
        page,
        async () => {
          await bLink.click();
        },
        /\/he\/buildings\/[0-9a-f-]{36}/,
      );
      buildingNavUrl = r.url;
      buildingDrillOk = r.navigated;
    }
  }
  record({
    action: 'Drill into a building (under an assigned project)',
    how: '/projects/{id}/buildings → click first building row → await /buildings/{id}',
    outcome: buildingDrillOk
      ? 'CONFIRMED: building detail opened'
      : buildingId
        ? 'DEAD/absent: building row did not navigate (API shows buildings exist)'
        : 'no buildings under this project (nothing to drill)',
    shouldAgent: 'yes',
    verdict: buildingDrillOk ? 'works' : buildingId ? 'FUNCTIONAL_BUG' : 'works',
    proof: `apiBuildingId=${buildingId ?? 'none'} navigated=${buildingDrillOk} url=${buildingNavUrl.replace(WEB, '')}`,
  });

  // Drill from a building into an apartment. The building DETAIL page does not
  // embed the apartment list — it links to /buildings/{id}/apartments (the
  // canonical "ניהול דירות" surface), where rows are <Link href=/apartments/
  // {id}>. Model that real path.
  let apartmentId: string | null = null;
  let apartmentDrillOk = false;
  if (buildingId) {
    await page.goto(`${WEB}/he/buildings/${buildingId}/apartments`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    const r = await apiGet(page, `/api/v1/buildings/${buildingId}/apartments`);
    if (r.ok()) {
      const d = JSON.parse(await r.text()) as { data: { id: string }[] };
      apartmentId = d.data[0]?.id ?? null;
    }
    const aptHrefs = await page
      .locator('a[href*="/apartments/"]')
      .evaluateAll((els) =>
        (els as HTMLAnchorElement[])
          .map((e) => e.getAttribute('href') ?? '')
          .filter((h) => /\/apartments\/[0-9a-f-]{36}$/.test(h)),
      );
    const aHref = aptHrefs[0];
    if (aHref) {
      const aLink = page.locator(`a[href="${aHref}"]`).first();
      const nav = await clickAndAwaitNav(
        page,
        async () => {
          await aLink.click();
        },
        /\/he\/apartments\/[0-9a-f-]{36}/,
      );
      apartmentDrillOk = nav.navigated;
    }
  }
  record({
    action: 'Drill into an apartment (under a building)',
    how: '/buildings/{id} → click first apartment row → await /apartments/{id}',
    outcome: apartmentDrillOk
      ? 'CONFIRMED: apartment detail opened'
      : apartmentId
        ? 'DEAD/absent: apartment row did not navigate (API shows apartments exist)'
        : 'no apartments under this building',
    shouldAgent: 'yes',
    verdict: apartmentDrillOk ? 'works' : apartmentId ? 'FUNCTIONAL_BUG' : 'works',
    proof: `apiApartmentId=${apartmentId ?? 'none'} navigated=${apartmentDrillOk}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 5 — VIEW OWNER DATA: the agent opens an owner. This seed agent has
  //   view_owner_pii=FALSE → PII must stay MASKED (bullets), and any reveal
  //   control must NOT yield cleartext. (should-see masked = yes; should-see
  //   cleartext = no.)
  // ───────────────────────────────────────────────────────────────────────
  await page.goto(`${WEB}/he/owners`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  let ownerId: string | null = null;
  let ownerMasked = false;
  let ownerListProof = '';
  {
    const r = await apiGet(page, '/api/v1/owners?limit=20');
    if (r.ok()) {
      const d = JSON.parse(await r.text()) as {
        data: { id: string; nationalIdMasked?: string; national_id?: string }[];
      };
      ownerId = d.data[0]?.id ?? null;
      // PII boundary: every row must be MASKED (no cleartext national_id key).
      const anyCleartext = d.data.some(
        (o) => typeof o.national_id === 'string' && /^\d{9}$/.test(o.national_id),
      );
      const allMasked = d.data.every((o) => (o.nationalIdMasked ?? '').includes('•'));
      ownerMasked = allMasked && !anyCleartext;
      ownerListProof = `rows=${d.data.length} allMasked=${allMasked} anyCleartext=${anyCleartext}`;
    } else {
      ownerListProof = `owners API HTTP ${r.status()}`;
    }
  }
  record({
    action: 'View owner records (list) — PII fidelity',
    how: 'GET /owners (agent cookie); assert national_id is MASKED (view_owner_pii=false)',
    outcome: ownerMasked
      ? 'CONFIRMED: owner PII is masked for this no-capability agent'
      : 'BUG: owner cleartext PII exposed to an agent without view_owner_pii',
    shouldAgent: 'yes',
    verdict: ownerMasked ? 'works' : 'AUTHZ_BUG',
    proof: ownerListProof,
  });

  // 5b — open the owner dossier and attempt to reveal cleartext PII.
  let revealLeaked = false;
  let revealProof = 'owner missing — skipped';
  if (ownerId) {
    await page.goto(`${WEB}/he/owners/${ownerId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    const revealBtn = page.locator('button', { hasText: 'הצג נתונים' });
    const hasReveal = (await revealBtn.count()) > 0;
    if (hasReveal) {
      const respP = page
        .waitForResponse((r) => r.url().includes('/reveal-pii'), { timeout: 8000 })
        .catch(() => null);
      await revealBtn
        .first()
        .click()
        .catch(() => {});
      const resp = await respP;
      await page.waitForTimeout(1000);
      const body = await page.locator('body').innerText();
      const cleartextShown = /\b\d{9}\b/.test(body);
      // an agent without the capability must be DENIED (4xx) and shown no
      // cleartext. Leak = a 200 reveal OR cleartext appearing on screen.
      revealLeaked = (resp?.status() === 200 && cleartextShown) || cleartextShown;
      revealProof = `reveal control present · reveal-pii HTTP ${resp?.status() ?? 'no-call'} · cleartext9=${cleartextShown}`;
    } else {
      revealProof = 'no reveal control offered to the no-capability agent (correct)';
    }
  }
  record({
    action: 'Reveal owner cleartext PII (agent without view_owner_pii)',
    how: 'owner dossier → reveal → assert NO cleartext national_id leaks',
    outcome: revealLeaked
      ? 'BUG: agent without view_owner_pii obtained cleartext national_id'
      : 'CONFIRMED: cleartext PII NOT exposed (reveal absent or denied)',
    shouldAgent: 'no',
    verdict: revealLeaked ? 'AUTHZ_BUG' : 'blocked_ok',
    proof: revealProof,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 6 — EDIT PROJECT DATA on an assigned project (per D.46 the agent
  //   MAY edit IFF it holds edit_project_data). This seed agent does NOT,
  //   so the BE returns 403. Confirm the UI doesn't silently claim success.
  //   Probe = PATCH an assigned building via the browser request (the same
  //   call the edit form makes) + check for an edit form/control in the UI.
  // ───────────────────────────────────────────────────────────────────────
  let editProof = 'no assigned building — skipped';
  let editVerdict: LedgerRow['verdict'] = 'works';
  let editOutcome = '';
  if (buildingId) {
    const patch = await page.request.patch(`${API}/api/v1/buildings/${buildingId}`, {
      data: { notes: `agent-edit-probe ${Date.now()}` },
      headers: { 'content-type': 'application/json' },
    });
    const status = patch.status();
    // re-read to confirm whether the edit actually persisted.
    const after = await apiGet(page, `/api/v1/buildings/${buildingId}`);
    const persisted = after.ok() && (await after.text()).includes('agent-edit-probe');
    if (status === 403 || status === 404) {
      editOutcome = `CONFIRMED: edit blocked (HTTP ${status}) — agent lacks edit_project_data, nothing persisted`;
      editVerdict = 'blocked_ok';
    } else if (status < 300 && persisted) {
      editOutcome = `EDIT SUCCEEDED (HTTP ${status}) — agent persisted a project-data change`;
      // succeeding is only a BUG if the agent lacks the capability; this seed
      // agent lacks it, so a 2xx here would be an AUTHZ side door.
      editVerdict = 'AUTHZ_BUG';
    } else {
      editOutcome = `ambiguous: HTTP ${status}, persisted=${persisted}`;
      editVerdict = 'FUNCTIONAL_BUG';
    }
    editProof = `PATCH /buildings/{id} → HTTP ${status} · persisted=${persisted}`;
  }
  record({
    action: 'Edit project data on an assigned project (PATCH building)',
    how: 'PATCH /buildings/{assigned} notes (the edit-form call) → status + API re-read',
    outcome: editOutcome || editProof,
    // This seed agent lacks edit_project_data, so being blocked IS correct.
    shouldAgent: 'no',
    verdict: editVerdict,
    proof: editProof,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 7 — FORBIDDEN: open an UNASSIGNED project by direct URL. MUST be
  //   blocked (the agent never sees it; the detail must 404 / not-found UI).
  // ───────────────────────────────────────────────────────────────────────
  await page.goto(`${WEB}/he/projects/${UNASSIGNED_PROJECT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
  const apiUnassigned = await apiGet(page, `/api/v1/projects/${UNASSIGNED_PROJECT}`);
  const unassignedApiStatus = apiUnassigned.status();
  const bodyText = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  // not-found UI shows t('projects.notFound') ("הפרויקט לא נמצא") and a back
  // button; the project name/tabs must NOT render.
  const tabsOnUnassigned = await page.getByRole('tab').count();
  const showsNotFound = /לא נמצא|not found/i.test(bodyText) && tabsOnUnassigned < 4;
  const blockedOk = unassignedApiStatus === 404 && showsNotFound;
  record({
    action: 'Open an UNASSIGNED project by direct URL (forbidden)',
    how: `goto /projects/${UNASSIGNED_PROJECT} → assert API 404 + not-found UI (no tabs)`,
    outcome: blockedOk
      ? 'CONFIRMED: blocked — API 404 + not-found UI, no project data leaked'
      : `WEAK/LEAK: apiStatus=${unassignedApiStatus} tabs=${tabsOnUnassigned}`,
    shouldAgent: 'no',
    verdict: blockedOk ? 'blocked_ok' : tabsOnUnassigned >= 4 ? 'AUTHZ_BUG' : 'FUNCTIONAL_BUG',
    proof: `apiStatus=${unassignedApiStatus} tabsRendered=${tabsOnUnassigned} notFoundUI=${showsNotFound}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 8 — FORBIDDEN: create a project. The agent sees the "פרויקט חדש"
  //   control (it's not role-gated in the UI). Following it + submitting MUST
  //   be blocked by the BE (403). Confirm: the wizard either is unreachable or
  //   the submit 403s and nothing is created.
  // ───────────────────────────────────────────────────────────────────────
  const apiCreate = await page.request.post(`${API}/api/v1/projects`, {
    data: { name: `agent-illegal ${Date.now()}`, type: 'tama38_2' },
    headers: { 'content-type': 'application/json' },
  });
  const createStatus = apiCreate.status();
  // also confirm the UI surfaces the control (UX note: shown but must dead-end).
  await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const createCtrlVisible = await page.locator('a[href$="/projects/new"]').count();
  const createBlocked = createStatus === 403;
  record({
    action: 'Create a project (forbidden for agent)',
    how: 'POST /projects (agent cookie) → assert 403; note whether the UI shows the control',
    outcome: createBlocked
      ? `CONFIRMED: create blocked (HTTP 403). UI still shows the "פרויקט חדש" control (${createCtrlVisible}) → UX leak of an unusable control`
      : `BUG/LEAK: POST /projects returned HTTP ${createStatus}`,
    shouldAgent: 'no',
    verdict: createBlocked ? 'blocked_ok' : 'AUTHZ_BUG',
    proof: `POST /projects HTTP ${createStatus} · createControlVisibleInUI=${createCtrlVisible}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 9 — FORBIDDEN: manage org members. Direct URL /he/members must not
  //   give the agent a working members surface; API /members must 403.
  // ───────────────────────────────────────────────────────────────────────
  const apiMembers = await apiGet(page, '/api/v1/members');
  const membersStatus = apiMembers.status();
  await page.goto(`${WEB}/he/members`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const membersBody = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  // a working members table would list emails; a blocked surface shows an
  // error / empty / redirect. We judge on the API 403 (authoritative) and
  // confirm no member emails leaked into the agent's DOM.
  const memberEmailLeak = /@alpha\.dev/.test(membersBody) && /manager@|viewer@/.test(membersBody);
  const membersBlocked = membersStatus === 403 && !memberEmailLeak;
  record({
    action: 'Manage org members (forbidden for agent)',
    how: 'GET /members API + open /he/members; assert API 403 + no member roster leak in DOM',
    outcome: membersBlocked
      ? 'CONFIRMED: members blocked (API 403, no roster leaked to the agent)'
      : `LEAK: membersStatus=${membersStatus} emailLeak=${memberEmailLeak}`,
    shouldAgent: 'no',
    verdict: membersBlocked ? 'blocked_ok' : 'AUTHZ_BUG',
    proof: `GET /members HTTP ${membersStatus} · memberRosterLeakInDOM=${memberEmailLeak}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 10 — FORBIDDEN: view the audit log. Manager-only (POLICY.audit
  //   read = MGR). API must 403; nav must not offer it (re-confirms ACTION 2).
  // ───────────────────────────────────────────────────────────────────────
  const apiAudit = await apiGet(page, '/api/v1/audit');
  const auditStatus = apiAudit.status();
  const auditBlocked = auditStatus === 403 || auditStatus === 404;
  record({
    action: 'View the audit log (forbidden for agent)',
    how: 'GET /audit (agent cookie) → assert 403/404',
    outcome: auditBlocked
      ? `CONFIRMED: audit blocked (HTTP ${auditStatus})`
      : `LEAK: audit HTTP ${auditStatus}`,
    shouldAgent: 'no',
    verdict: auditBlocked ? 'blocked_ok' : 'AUTHZ_BUG',
    proof: `GET /audit HTTP ${auditStatus}`,
  });

  // ───────────────────────────────────────────────────────────────────────
  // ACTION 11 — A LEGITIMATE field action that SHOULD work: read the agent's
  //   own tasks list (read = ALL, assignee-scoped). Confirm it loads its data.
  // ───────────────────────────────────────────────────────────────────────
  await page.goto(`${WEB}/he/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const apiTasks = await apiGet(page, '/api/v1/tasks?limit=50');
  const tasksStatus = apiTasks.status();
  let tasksProof = `GET /tasks HTTP ${tasksStatus}`;
  let tasksWorks = false;
  if (tasksStatus === 200) {
    const d = JSON.parse(await apiTasks.text()) as { data: unknown[] };
    // the list page renders without an error state.
    const errShown = /טעינת.*נכשלה|failed/i.test(
      await page
        .locator('main')
        .innerText()
        .catch(() => ''),
    );
    tasksWorks = !errShown;
    tasksProof = `GET /tasks HTTP 200, rows=${d.data.length}, listErrorShown=${errShown}`;
  }
  record({
    action: 'View own tasks list (legitimate read)',
    how: 'GET /tasks (agent cookie) + assert /he/tasks renders without an error state',
    outcome: tasksWorks
      ? 'CONFIRMED: tasks list loads for the agent'
      : `FAILED: tasks list did not load (HTTP ${tasksStatus} or error UI)`,
    shouldAgent: 'yes',
    verdict: tasksWorks ? 'works' : 'FUNCTIONAL_BUG',
    proof: tasksProof,
  });

  // ───────────────────────────────────────────────────────────────────────
  // Artifact dump + summary.
  // ───────────────────────────────────────────────────────────────────────
  const summary = {
    persona: 'agent@alpha.dev',
    ranAt: new Date().toISOString(),
    groundTruth: {
      viewOwnerPii: false,
      assignedProjects: apiProjectCount,
      managerProjects: 13,
    },
    totals: {
      actions: ledger.length,
      worked: ledger.filter((r) => r.verdict === 'works').length,
      functionalBugs: ledger.filter((r) => r.verdict === 'FUNCTIONAL_BUG').length,
      authzBugs: ledger.filter((r) => r.verdict === 'AUTHZ_BUG').length,
      blockedOk: ledger.filter((r) => r.verdict === 'blocked_ok').length,
      uxDeadClicks: ledger.filter((r) => r.verdict === 'UX_dead_click').length,
    },
    consoleErrors,
    ledger,
  };
  writeFileSync(`${ART}/persona-agent-ledger.json`, JSON.stringify(summary, null, 2), 'utf-8');
  // eslint-disable-next-line no-console
  console.log('[DV][SUMMARY] ' + JSON.stringify(summary.totals));
  // eslint-disable-next-line no-console
  console.log('[DV][CONSOLE-ERRORS] ' + (consoleErrors.join(' || ') || '(none)'));

  // The spec is a REPORT — it must not fail on a product bug. Assert only that
  // the harness ran every planned action.
  expect(ledger.length).toBe(14);
});
