import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { request } from '@playwright/test';

import { test, expect, WEB, API } from './_helpers';

/**
 * LAYER 2 — SINGLE-ACTOR FLOWS. Each core flow start→end as one persona,
 * with assertions derived from the SPEC/DECISIONS (not the code):
 *   - D.19: national_id is PII — must be masked on the wire, never cleartext.
 *   - {data} envelope (D.16).
 *   - RBAC (D.17): Viewer is read-only — a create MUST be refused server-side.
 * Verdicts: COMPLETE / PARTIAL(step X) / BLOCKED. Records → layer2/<flow>.json.
 */

const OUT = join(__dirname, '..', '..', '..', '..', 'docs', 'audit', 'artifacts', 'layer2');
mkdirSync(OUT, { recursive: true });

function record(name: string, data: unknown) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

/** Valid Israeli national_id: random 8 digits + computed check digit. */
function validNationalId(): string {
  const base = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10));
  let sum = 0;
  base.forEach((d, i) => {
    let v = d * ((i % 2) + 1);
    if (v > 9) v -= 9;
    sum += v;
  });
  const check = (10 - (sum % 10)) % 10;
  return base.join('') + String(check);
}

const ts = Date.now();

/**
 * Owners this suite creates against the REAL dev backend (the owner-create flow
 * below). Tracked + soft-archived in afterAll so the audit run stops polluting
 * the demo org's owners list (`audit-owner-*` rows were accumulating). We delete
 * ONLY ids we created this run, by exact id — standard fixture teardown.
 */
const createdOwnerIds: string[] = [];

test.describe('Layer 2 — manager flows', () => {
  test.use({ storageState: join(__dirname, '.auth', 'manager.json') });

  test.afterAll(async () => {
    if (createdOwnerIds.length === 0) return;
    const ctx = await request.newContext({
      storageState: join(__dirname, '.auth', 'manager.json'),
    });
    for (const id of createdOwnerIds) {
      // Soft archive (DELETE = archived_at); best-effort, never fail teardown.
      await ctx.delete(`${API}/api/v1/owners/${id}`).catch(() => {});
    }
    await ctx.dispose();
  });

  test('FLOW project-create (wizard 3-step)', async ({ page }) => {
    const name = `audit-proj-${ts}`;
    const ev: Record<string, unknown> = { flow: 'project-create', name };
    await page.goto(`${WEB}/he/projects/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.fill('#name', name);
    ev.step1Filled = await page.locator('#name').inputValue();
    const nextBtn = page.locator('button:has-text("הבא")').last();
    // next → step 2
    await nextBtn.click();
    await page.waitForTimeout(300);
    // next → step 3 (skip buildings)
    await nextBtn.click();
    await page.waitForTimeout(300);
    // submit (only the step-3 Create button is type=submit)
    const postResp = page.waitForResponse(
      (r) => r.url().includes('/api/v1/projects') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.locator('button[type=submit]').click();
    let status = 0;
    let postBody: any = null;
    try {
      const r = await postResp;
      status = r.status();
      postBody = await r.json().catch(() => null);
    } catch {
      /* */
    }
    ev.postStatus = status;
    ev.postBodyKeys = postBody?.data ? Object.keys(postBody.data) : Object.keys(postBody ?? {});
    await page.waitForTimeout(1800);
    ev.finalUrl = page.url();
    ev.visibleErrorBanner = (
      await page
        .locator('[role=alert]')
        .allInnerTexts()
        .catch(() => [])
    ).filter(Boolean);
    const m = page.url().match(/\/projects\/([0-9a-f-]{36})/);
    const onDetail = !!m;
    ev.landedOnDetail = onDetail;
    // Deterministic verification: GET the project by id (not a paginated scan).
    let getById = 0;
    let nameMatch = false;
    if (m) {
      const r = await page.request.get(`${API}/api/v1/projects/${m[1]}`);
      getById = r.status();
      const b = await r.json().catch(() => null);
      nameMatch = b?.data?.name === name;
    }
    ev.getByIdStatus = getById;
    ev.nameMatch = nameMatch;
    ev.verdict =
      status === 201 && onDetail && nameMatch
        ? 'COMPLETE'
        : `PARTIAL(post=${status},detail=${onDetail},nameMatch=${nameMatch})`;
    record('project-create', ev);
    expect(status, 'project create POST should be 201').toBe(201);
    expect(
      onDetail && nameMatch,
      'should land on detail page showing the created project',
    ).toBeTruthy();
  });

  test('FLOW owner-create + PII masking (D.19)', async ({ page }) => {
    const name = `audit-owner-${ts}`;
    const nid = validNationalId();
    const phone = '0521234567';
    const ev: Record<string, unknown> = { flow: 'owner-create', name, nidUsed: nid };

    // (a) FE form best-effort (RHF hydration-race prone — see login finding).
    await page.goto(`${WEB}/he/owners/new`, { waitUntil: 'domcontentloaded' });
    await page.locator('#name').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
    await page.fill('#name', name);
    await page.fill('#national_id', nid);
    await page.fill('#phone', phone);
    await expect(page.locator('#national_id')).toHaveValue(nid);
    const fePost = page.waitForResponse(
      (r) => r.url().includes('/api/v1/owners') && r.request().method() === 'POST',
      { timeout: 12_000 },
    );
    await page.locator('button[type=submit]').click();
    let feStatus = 0;
    try {
      const r = await fePost;
      feStatus = r.status();
    } catch {
      /* */
    }
    ev.feFormPostStatus = feStatus;
    ev.feFormLandedDetail = /\/owners\/[0-9a-f-]{36}/.test(page.url());
    const feOwnerId = page.url().match(/\/owners\/([0-9a-f-]{36})/)?.[1];
    if (feOwnerId) createdOwnerIds.push(feOwnerId);

    // (b) Authoritative D.19 check via the REAL API (deterministic).
    const nid2 = validNationalId();
    const apiResp = await page.request.post(`${API}/api/v1/owners`, {
      data: { name: `${name}-api`, national_id: nid2, phone },
      headers: { 'Content-Type': 'application/json' },
    });
    const apiStatus = apiResp.status();
    const apiBody = await apiResp.json().catch(() => null);
    const apiOwnerId = (apiBody as { data?: { id?: string } } | null)?.data?.id;
    if (apiOwnerId) createdOwnerIds.push(apiOwnerId);
    const raw = JSON.stringify(apiBody ?? {});
    ev.apiCreateStatus = apiStatus;
    ev.apiResponseKeys = apiBody?.data ? Object.keys(apiBody.data) : [];
    ev.rawNidLeakedInResponse = raw.includes(nid2);
    ev.responseHasMaskedNid = /nationalIdMasked/.test(raw);
    ev.maskedValue = apiBody?.data?.nationalIdMasked ?? null;
    ev.verdict =
      apiStatus === 201 && !ev.rawNidLeakedInResponse && ev.responseHasMaskedNid
        ? 'COMPLETE(create works + national_id masked, D.19 honoured)'
        : `CHECK(api=${apiStatus},leak=${ev.rawNidLeakedInResponse},masked=${ev.responseHasMaskedNid})`;
    record('owner-create', ev);
    expect(apiStatus, 'owner create (API) should be 201').toBe(201);
    expect(
      ev.rawNidLeakedInResponse,
      'national_id MUST NOT appear cleartext in API response (D.19)',
    ).toBeFalsy();
    expect(ev.responseHasMaskedNid, 'response should expose nationalIdMasked (D.19)').toBeTruthy();
  });
});

test.describe('Layer 2 — viewer RBAC (read-only, D.17)', () => {
  test.use({ storageState: join(__dirname, '.auth', 'viewer.json') });

  test('FLOW viewer cannot create project (server-side RBAC)', async ({ page }) => {
    const ev: Record<string, unknown> = { flow: 'viewer-create-project' };
    // 1. Does the viewer even see a "create" CTA on the list?
    await page.goto(`${WEB}/he/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const createCta = await page
      .getByRole('link', { name: /פרויקט חדש|create/i })
      .count()
      .catch(() => 0);
    ev.createCtaVisibleToViewer = createCta > 0;
    // 2. The authoritative check: viewer POST must be refused by the BE.
    const resp = await page.request.post(`${API}/api/v1/projects`, {
      data: { name: `audit-viewer-should-fail-${ts}`, type: 'tama38_2' },
      headers: { 'Content-Type': 'application/json' },
    });
    ev.viewerCreateStatus = resp.status();
    const body = await resp.json().catch(() => null);
    ev.viewerCreateBody = body;
    ev.verdict =
      resp.status() === 403
        ? 'COMPLETE(403 as required)'
        : `FAIL(expected 403, got ${resp.status()})`;
    record('viewer-create-project', ev);
    expect([401, 403], 'Viewer create must be refused server-side (D.17)').toContain(resp.status());
  });
});
