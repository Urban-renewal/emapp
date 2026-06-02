import * as fs from 'node:fs';
import * as path from 'node:path';

import { request as pwRequest } from '@playwright/test';

import { test, expect, observe, WEB, API } from './_helpers';

/**
 * DV — Interface 4 (Contractor — share-link, read-only).
 *
 * The contractor has NO login: entry is a valid share-link a MANAGER minted.
 * This suite is SELF-CONTAINED — it logs in as the manager via the API
 * (setup only, NOT under test), creates/reuses a contractor share on the
 * Pilot project, and mints a fresh share-access token at runtime. No token
 * is hardcoded (they expire); the spec is a permanent CI regression gate.
 *
 * It then drives BOTH layers:
 *   1. The BROWSER read-view (`/he/contractor/share/[token]`) — screenshots,
 *      console, network, oracle assertions on the rendered DOM.
 *   2. The BE `/contractor/*` boundary — the security oracle that the UI
 *      can't show: PII-boundary scan of every response body, IDOR on
 *      download (apartment-linked + cross-project doc ids → 404, never a
 *      minted URL), auth (missing / garbage token → 401), and revocation
 *      (revoke → immediate 401). A throwaway share is used for revocation so
 *      the primary share survives.
 *
 * Artifacts → docs/DV/results/artifacts/contractor-*.png
 * Evidence rollup → docs/DV/results/artifacts/contractor-evidence.json
 *
 * Seed:demo oracle (Pilot project 1ace1c99, org Alpha), 2026-06-02:
 *   project: "Tama 38/2 — Pilot", status gathering_signatures, type tama38_2
 *   buildings: 2 (בן יהודה 25, הרצל 10) · apartments: 4 total
 *   progress: signed=2 pending=2 total=4 (AGGREGATE only — no identities,
 *             AND no consent-vs-threshold / per-building / velocity stat)
 *   documents (project-level only): 2 (blueprint + regulation pdf)
 *   owner PII anywhere: NONE (structural — no owners table queried)
 */

const ART = 'C:/emapp/docs/DV/results/artifacts';
fs.mkdirSync(ART, { recursive: true });

// Setup-only fixtures (DV-PLAN §2 — NOT under test; they get us to the
// post-mint contractor entry state).
const MANAGER = { email: 'manager@alpha.dev', password: 'DevPassword123!' };
const PROJECT_ID = '1ace1c99-19fb-48b5-8bd8-0c0e886b605c'; // Tama 38/2 — Pilot
const CONTRACTOR_A = 'afa0059f-5d65-4e90-9b16-1d2d10e6ab64'; // אדריכלי לוין — primary share
const CONTRACTOR_B = '2d3680e1-ea01-4a72-a203-a64358cc5f03'; // אורבן בנייה — throwaway (revocation)

// IDOR candidates harvested from GET /api/v1/documents (manager cookie):
const PROJECT_DOC_ID = 'f87283dc-5aef-4229-ac29-8ab8e899d592'; // project-level doc of THE pilot → legit download
const SAME_PROJ_APT_DOC = 'a96d6ef3-ba59-404a-9768-38c48db5ec4a'; // pilot doc but apartment-linked (resident agreement) → MUST 404
const OTHER_PROJ_DOC = 'c1e4cfdd-7568-47e7-a7c3-312909ecdc9a'; // another project's project-level doc → MUST 404

// A full-grant permission set (overview + documents+download + signatures).
const FULL_PERMS = {
  overview: { on: true },
  tenants: {
    on: false,
    fields: { name: true, phone: false, email: false, national_id: false, note: false },
  },
  documents: { on: true, actions: { download: true, upload: false } },
  signatures: { on: true },
  notes: { on: false },
  team: { on: false },
};

// PII needles that MUST NEVER appear in any contractor response/DOM. These
// are real seed owner identities for the pilot (harvested as a negative
// oracle — if any surfaces, the structural boundary failed).
const PII_NEEDLES = ['national_id', 'nationalId', 'phone', 'ownerName', 'ownership', 'דנה כהן'];

interface Finding {
  id: string;
  axis: string;
  severity: string;
  title: string;
  evidence: Record<string, unknown>;
}
const findings: Finding[] = [];
const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), findings };

function writeRollup(): void {
  fs.writeFileSync(
    path.join(ART, 'contractor-evidence.json'),
    JSON.stringify(evidence, null, 2),
    'utf8',
  );
}

/** Scan a stringified body/DOM for owner-PII needles; returns the hits. */
function scanPii(label: string, text: string): string[] {
  const hits = PII_NEEDLES.filter((n) => text.includes(n));
  if (hits.length > 0) {
    findings.push({
      id: 'DV-CON-PII',
      axis: 'security',
      severity: 'CRITICAL',
      title: `Owner PII leaked into contractor surface: ${label}`,
      evidence: { label, hits, sample: text.slice(0, 400) },
    });
  }
  return hits;
}

test.describe.serial('DV contractor — Interface 4 (share-link, read-only)', () => {
  let token: string; // primary share-access token (fresh, runtime-minted)

  test('walk the contractor read-view + BE boundary oracle', async ({ browser, request }) => {
    test.setTimeout(600_000);

    // The `request` fixture shares a cookie jar with the manager login below,
    // so a Bearer-token probe through it would also carry the manager cookie
    // (masking auth-tier confusion). `anon` is a COOKIE-LESS context — the
    // share token is then the SOLE credential, exactly like a real contractor.
    const anon = await pwRequest.newContext();

    // ---- SETUP: manager session → mint a fresh share token ------------------
    const login = await request.post(`${API}/api/v1/auth/login`, { data: MANAGER });
    expect(login.ok(), 'manager login (setup)').toBeTruthy();
    const mgrCookie = (login.headers()['set-cookie'] ?? '')
      .split('\n')
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(mgrCookie, 'manager session cookie').toContain('=');

    // Reuse an existing contractor-A share on the project, else create one.
    const listRes = await request.get(`${API}/api/v1/projects/${PROJECT_ID}/shares`, {
      headers: { cookie: mgrCookie },
    });
    const listed = (await listRes.json()) as { data: Array<{ id: string; contractorId: string }> };
    let shareId = listed.data.find((s) => s.contractorId === CONTRACTOR_A)?.id;
    if (!shareId) {
      const created = await request.post(`${API}/api/v1/projects/${PROJECT_ID}/shares`, {
        headers: { cookie: mgrCookie },
        data: { contractorId: CONTRACTOR_A, permissions: FULL_PERMS },
      });
      expect(created.ok(), 'create primary share').toBeTruthy();
      shareId = ((await created.json()) as { data: { id: string } }).data.id;
    }
    const linkRes = await request.post(`${API}/api/v1/shares/${shareId}/link`, {
      headers: { cookie: mgrCookie },
    });
    expect(linkRes.ok(), 'mint share link').toBeTruthy();
    token = ((await linkRes.json()) as { data: { token: string } }).data.token;
    expect(token.length, 'token minted').toBeGreaterThan(20);

    // ---- BE ORACLE: PII boundary + aggregate-only + structural shape --------
    const auth = { headers: { authorization: `Bearer ${token}` } };

    const projRes = await anon.get(`${API}/api/v1/contractor/project`, auth);
    const projBody = await projRes.text();
    expect(projRes.status(), 'GET /contractor/project').toBe(200);
    const piiProject = scanPii('GET /contractor/project body', projBody);
    const projJson = JSON.parse(projBody) as {
      data: { project: { name: string; status: string; type: string }; buildings: unknown[] };
    };
    expect(projJson.data.project.name, 'project name oracle').toContain('Pilot');
    expect(projJson.data.project.status).toBe('gathering_signatures');
    expect(projJson.data.buildings.length, 'building count oracle').toBe(2);

    const progRes = await anon.get(`${API}/api/v1/contractor/progress`, auth);
    const progBody = await progRes.text();
    expect(progRes.status(), 'GET /contractor/progress').toBe(200);
    const piiProgress = scanPii('GET /contractor/progress body', progBody);
    const progJson = JSON.parse(progBody) as {
      data: { signaturesSigned: number; signaturesPending: number; signaturesTotal: number };
    };
    // AGGREGATE only: counts present, no identity keys, totals consistent.
    expect(progJson.data.signaturesTotal).toBe(
      progJson.data.signaturesSigned + progJson.data.signaturesPending,
    );
    expect(Object.keys(progJson.data).sort(), 'progress is counts-only (no who)').toEqual([
      'signaturesPending',
      'signaturesSigned',
      'signaturesTotal',
    ]);

    const docsRes = await anon.get(`${API}/api/v1/contractor/documents`, auth);
    const docsBody = await docsRes.text();
    expect(docsRes.status(), 'GET /contractor/documents').toBe(200);
    const piiDocs = scanPii('GET /contractor/documents body', docsBody);
    const docsJson = JSON.parse(docsBody) as { data: Array<{ id: string; name: string }> };
    // Project-level only — none of the apartment-linked "הסכם דייר" agreements.
    expect(
      docsJson.data.every((d) => !d.name.includes('הסכם דייר')),
      'no per-owner (apartment) agreements in contractor docs',
    ).toBeTruthy();

    // ---- MISSING-FEATURE: consent-vs-threshold / per-building / velocity ----
    // The urban-renewal-relevant number (% signed vs the legal majority) is
    // absent: progress is raw signed/pending/total with NO threshold, NO
    // per-building breakdown, NO velocity. ERGO / missing-feature finding.
    const hasThreshold = /threshold|majority|legalMajority|רוב|consentRate/i.test(progBody);
    const hasPerBuilding = /byBuilding|perBuilding|buildings/i.test(progBody);
    if (!hasThreshold && !hasPerBuilding) {
      findings.push({
        id: 'DV-CON-1',
        axis: 'ergonomics/missing-feature',
        severity: 'MEDIUM',
        title:
          'Contractor progress surfaces raw counts only — no consent-vs-legal-threshold, no per-building breakdown, no velocity',
        evidence: {
          endpoint: 'GET /contractor/progress',
          body: progJson.data,
          rationale:
            'תמ"א 38 / פינוי-בינוי decisions hinge on % signed vs the statutory majority. The contractor sees signed/total but not the threshold gap, per-building progress, or signing velocity — the actual decision inputs.',
          feFile:
            'apps/web/src/app/[locale]/(contractor)/contractor/share/[token]/page.tsx renders pct = signed/total only',
        },
      });
    }

    // ---- IDOR: download must be scope-locked --------------------------------
    const dlLegit = await anon.get(
      `${API}/api/v1/contractor/documents/${PROJECT_DOC_ID}/download`,
      auth,
    );
    expect(dlLegit.status(), 'legit project-level doc download → 200').toBe(200);
    const dlLegitBody = (await dlLegit.json()) as { data: { url: string } };
    expect(dlLegitBody.data.url, 'presigned url minted for legit doc').toContain('http');

    const idorSameProjApt = await anon.get(
      `${API}/api/v1/contractor/documents/${SAME_PROJ_APT_DOC}/download`,
      auth,
    );
    const idorOtherProj = await anon.get(
      `${API}/api/v1/contractor/documents/${OTHER_PROJ_DOC}/download`,
      auth,
    );
    const idorRandom = await anon.get(
      `${API}/api/v1/contractor/documents/00000000-0000-0000-0000-000000000000/download`,
      auth,
    );
    expect(idorSameProjApt.status(), 'apartment-linked same-project doc → 404').toBe(404);
    expect(idorOtherProj.status(), 'cross-project doc → 404').toBe(404);
    expect(idorRandom.status(), 'random uuid → 404').toBe(404);
    // None of the IDOR responses may contain a minted URL.
    for (const [label, res] of [
      ['idor-same-proj-apt', idorSameProjApt],
      ['idor-other-proj', idorOtherProj],
    ] as const) {
      const body = await res.text();
      if (/X-Amz-Signature|cloudflarestorage|https?:\/\//.test(body)) {
        findings.push({
          id: 'DV-CON-IDOR',
          axis: 'security',
          severity: 'CRITICAL',
          title: `IDOR: download minted a URL for an out-of-scope doc (${label})`,
          evidence: { label, body: body.slice(0, 300) },
        });
      }
    }

    // ---- AUTH boundary ------------------------------------------------------
    const noToken = await anon.get(`${API}/api/v1/contractor/project`);
    const garbage = await anon.get(`${API}/api/v1/contractor/project`, {
      headers: { authorization: 'Bearer garbage.token.here' },
    });
    // Cross-tier: the share token must NOT open the org owners endpoint.
    const ownersWithShare = await anon.get(`${API}/api/v1/owners`, auth);
    expect(noToken.status(), 'no token → 401').toBe(401);
    expect(garbage.status(), 'garbage token → 401').toBe(401);
    expect(ownersWithShare.status(), 'share token cannot read org /owners').toBe(401);
    scanPii('GET /owners with share token (should be 401)', await ownersWithShare.text());

    // ---- REVOCATION (throwaway share so the primary survives) ---------------
    let revokeProbe: { before: number; after: number } | null = null;
    const tw = await request.post(`${API}/api/v1/projects/${PROJECT_ID}/shares`, {
      headers: { cookie: mgrCookie },
      data: { contractorId: CONTRACTOR_B, permissions: FULL_PERMS },
    });
    if (tw.ok()) {
      const twId = ((await tw.json()) as { data: { id: string } }).data.id;
      const twLink = await request.post(`${API}/api/v1/shares/${twId}/link`, {
        headers: { cookie: mgrCookie },
      });
      const twToken = ((await twLink.json()) as { data: { token: string } }).data.token;
      const twAuth = { headers: { authorization: `Bearer ${twToken}` } };
      const before = await anon.get(`${API}/api/v1/contractor/project`, twAuth);
      await request.delete(`${API}/api/v1/shares/${twId}`, { headers: { cookie: mgrCookie } });
      const after = await anon.get(`${API}/api/v1/contractor/project`, twAuth);
      revokeProbe = { before: before.status(), after: after.status() };
      expect(before.status(), 'throwaway share works before revoke').toBe(200);
      expect(after.status(), 'revoked share → 401 immediately').toBe(401);
    }

    // ---- BROWSER read-view --------------------------------------------------
    const context = await browser.newContext({ baseURL: WEB });
    const page = await context.newPage();
    const o = observe(page);
    const url = `${WEB}/he/contractor/share/${token}`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page
      .screenshot({ path: path.join(ART, 'contractor-share-view.png'), fullPage: true })
      .catch(() => {});
    const dom = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 6000);
    const piiDom = scanPii('contractor read-view DOM', dom);

    // Oracle: the rendered view shows the project + progress + buildings.
    expect(dom, 'view renders project name').toContain('Pilot');
    expect(dom, 'view renders a building address').toContain('בן יהודה');

    const docStatus = resp?.status() ?? null;
    await context.close();

    // ---- ROLLUP -------------------------------------------------------------
    Object.assign(evidence, {
      tokenMinted: true,
      shareId,
      project: projJson.data.project,
      buildingCount: projJson.data.buildings.length,
      progress: progJson.data,
      documents: docsJson.data.map((d) => ({ id: d.id, name: d.name })),
      piiBoundary: {
        verdict:
          piiProject.length + piiProgress.length + piiDocs.length + piiDom.length === 0
            ? 'CLEAN'
            : 'LEAK',
        scanned: ['project', 'progress', 'documents', 'owners-401', 'read-view-DOM'],
      },
      idor: {
        legitDownload: dlLegit.status(),
        apartmentLinkedSameProject: idorSameProjApt.status(),
        crossProject: idorOtherProj.status(),
        random: idorRandom.status(),
      },
      auth: {
        noToken: noToken.status(),
        garbage: garbage.status(),
        ownersWithShareToken: ownersWithShare.status(),
      },
      revocation: revokeProbe,
      browser: {
        docStatus,
        // Path only — never persist the share token (a credential) to the
        // committed evidence artifact.
        finalPath: new URL(page.url()).pathname.replace(token, '<token>'),
        consoleErrors: o.consoleErrors,
        pageErrors: o.pageErrors,
      },
      missingFeature: { hasThreshold, hasPerBuilding },
    });
    writeRollup();

    // ---- HARD ASSERTIONS (the verdict) --------------------------------------
    // PII boundary is the CRITICAL gate — zero hits across every surface.
    expect(piiProject, 'no owner PII in /contractor/project').toEqual([]);
    expect(piiProgress, 'no owner PII in /contractor/progress').toEqual([]);
    expect(piiDocs, 'no owner PII in /contractor/documents').toEqual([]);
    expect(piiDom, 'no owner PII in the rendered read-view').toEqual([]);
    // No CRITICAL finding may have been logged (PII leak or IDOR).
    expect(
      findings.filter((f) => f.severity === 'CRITICAL'),
      `CRITICAL findings: ${findings
        .filter((f) => f.severity === 'CRITICAL')
        .map((f) => f.title)
        .join(' | ')}`,
    ).toEqual([]);
    // Browser view rendered with no console/page errors.
    expect(o.consoleErrors, `console errors: ${o.consoleErrors.join(' | ')}`).toEqual([]);
    expect(o.pageErrors, `page errors: ${o.pageErrors.join(' | ')}`).toEqual([]);
    expect(docStatus, 'read-view returned a document').not.toBeNull();
  });
});
