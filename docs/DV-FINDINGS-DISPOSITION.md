# Deep-Verification (DV) findings — disposition + PR closure

The DV track (persona-based deep verification, PRs #231–240, dated 2026-06-02)
ran BEFORE the enterprise-IAM rework (#248). Its e2e specs test the pre-IAM
(role-string) authorization model and are cumulative/stacked on the old `main`,
so they would conflict + test obsolete behaviour after #248 merges. This file
captures every gated DV finding (source: the trusted `docs/DV/results/
VERIFICATION-LOG.md`) with its disposition, so the value is preserved and the 10
DV PRs can be closed cleanly.

## Findings ledger

| ID                       | Sev                                                                     | Finding                                                                                                                                                                                                                                                                                                                                          | Disposition                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DV-MGR-DOCS**          | HIGH (ship-blocker)                                                     | Manager can't send any doc to signature — FE `DocumentTypeEnum` (contract/permit/…) is DISJOINT from the BE's real free-text types (agreement/blueprint/regulation), so `z.array(DocumentSchema).parse` throws on every seeded row → documents surface + signature picker silently break; "agreement" (the core signed doc) wasn't even offered. | **✅ FIXED** (commit `d60b5bc`): `DocumentSchema.type` is now tolerant `z.string()` (READ never throws); `DocumentTypeEnum` includes the real types (agreement/blueprint/regulation); the label-map falls back for unknown. Regression tests added. |
| **DV-ORG-9**             | LOW (UX; downgraded from MED-HIGH — _not_ security, BE 403s everything) | ~30 dead write-controls shown to Viewer across 12 surfaces (read-only role looks writable, dead-ends).                                                                                                                                                                                                                                           | **✅ ADDRESSED** by IAM slice-5b FE permission-gating + the assignments-page fix — Viewer/Agent no longer see write controls they can't use.                                                                                                        |
| **DV-AGENT-CREATE**      | LOW (UX, same class)                                                    | Agent sees a "create project" control it can't submit (POST → 403).                                                                                                                                                                                                                                                                              | **✅ ADDRESSED** by IAM FE gating — the create CTA is now hidden for roles lacking `projects.create` (confirmed by the j8 e2e fix).                                                                                                                 |
| **DV-AGENT-NAV**         | (was HIGH)                                                              | "Agent can't open its assigned projects."                                                                                                                                                                                                                                                                                                        | **⚪ REFUTED / FALSE** — a `getByText().click()` hydration-race artifact; the project card is a plain `<Link href>`, ungated, navigates for any role. Structurally confirmed false. Closed.                                                         |
| **DV-PROV-AUDIT**        | MED (compliance)                                                        | `provider_audit_log` has no in-product read endpoint — a Provider Admin can't review their own audited actions (the tier whose whole security story is "every action is audited").                                                                                                                                                               | **🟡 OPEN — follow-up.** Real gap; add a provider-audit read endpoint. Post-MVP (provider tier polish).                                                                                                                                             |
| **DV-CON-1**             | MED/feature                                                             | Contractor consent-threshold logic missing.                                                                                                                                                                                                                                                                                                      | **🟡 OPEN — feature follow-up** (contractor flow). Post-MVP.                                                                                                                                                                                        |
| **DV-MGR-OWNER-ACTIONS** | LOW (UX)                                                                | 4 owner quick-actions (WhatsApp / send-for-signature / add-note / create-task) on the owner detail page are disabled "בקרוב" placeholders.                                                                                                                                                                                                       | **🟡 DEFERRED** — intentional placeholders, not bugs; wire them in a polish slice.                                                                                                                                                                  |
| **DV-ORG-1**             | LOW (UX)                                                                | UI jargon / copy issues.                                                                                                                                                                                                                                                                                                                         | **🟡 OPEN — product/UX polish.** Post-MVP.                                                                                                                                                                                                          |
| **DV-ORG-2**             | LOW (UX)                                                                | A KPI / dashboard-stat issue.                                                                                                                                                                                                                                                                                                                    | **🟡 OPEN — product polish.** Post-MVP.                                                                                                                                                                                                             |

## Confirmed CLEAN (DV's positive results — preserved as assurance)

- **Viewer security:** all 20 mutating actions BE-blocked (403), nothing persisted, each reproduced ≥2× — genuinely read-only. 0 authz bugs.
- **Agent boundary:** unassigned project → 404 (no leak), members/audit → 403, PII masked. Clean.
- **Provider console:** onboard creates org (201 + appears in tenants), suspend/reactivate work, gate enforces — 0 bugs (the owner's "nothing works" REFUTED in a clean run).
- **Cross-entity sync (the owner's #1 dimension):** all 5 ripples sync (signature→roles, assignment, archive, share-revoke, provider-suspend-kills-session), 0 desync.
- **Contractor:** share-link PII-clean + IDOR-safe. **Tenant/resident:** own-data-only confirmed.

## Operational note (NOT a code bug)

- **PERF-2 / demo reliability:** `next dev` lazy-compiles + 500s/deadlocks under load → it produced two FALSE "nothing works" reports (agent, provider) that both refuted on re-run. **Any demo must be a production build** (`pnpm build` then `next start` + `nest build`) — not the dev server.

## PR disposition

PRs #231–240 are **closed** (this file is the reference). Rationale: pre-IAM e2e specs, cumulative, would conflict + test obsolete authz against the post-#248 model; their value (findings above) is captured here, the one ship-blocker is fixed, and re-verification against the new model is the IAM PR's own suite + the per-role browser smoke (`docs/IAM-BROWSER-SMOKE.md`). The branches persist and are reopenable if any specific coverage is to be rebased onto the new `main`.

## Open backlog after this (post-MVP, none block the IAM merge)

DV-PROV-AUDIT (MED, provider audit read endpoint) · DV-CON-1 (contractor consent) · DV-ORG-1/ORG-2 (UX/KPI polish) · DV-MGR-OWNER-ACTIONS (wire the 4 owner quick-actions).

## MQA-1 — CRITICAL ship-blocker (found 2026-06-04, manual QA on production build)

**Finding.** EVERY FE page renders **blank (white)** in the production build. Root
cause: `apps/web/next.config.ts` sets `script-src 'self'` for `NODE_ENV=production`
(line 82) with **no nonce and no `'unsafe-inline'`**. The doc-comment (line 48)
reasons only about Tailwind ("ships zero inline scripts") and MISSES that **Next.js
App Router itself emits inline bootstrap + RSC-flight scripts** (`self.__next_f.push(...)`).
The browser blocks those inline scripts → `self.__next_f` stays `[]` → the React
Flight client throws `Error: Connection closed.` → hydration never runs → blank page.

**Proof (real browser, prod build via `start-prod-local.ps1`):**

- planted inline `<script>` did NOT execute (`inlineScriptExecutes:false`) → CSP blocks ALL inline.
- `self.__next_f` length `0` despite 6 inline `<script>` tags present in the SSR HTML.
- console: `Error: Connection closed.` on every load; `bodyText` length 0 (white).
- SSR HTML itself is COMPLETE (`curl` → 65 KB, `"error":null`, form present) → it is purely the CSP blocking client hydration, not an SSR error.

**Scope / severity.** Affects production (`NODE_ENV=production`) on every FE route.
No Cloudflare `_headers` / wrangler / Pages-Function CSP override exists in the repo,
so the next.config CSP is authoritative in all envs. Dev (`unsafe-inline 'unsafe-eval'`)
masked it; jsdom/Playwright-on-dev never exercised the prod CSP — same class as the
S1 GET-fallback lesson. **Blocks ALL manual QA** (nothing renders) AND would ship a
blank app. NOT a browser-state artifact (a stale MSW service-worker was found + cleared
first, but the blank persisted with `swCount:0`).

**Disposition:** ✅ **FIXED** (nonce-based CSP, the official Next pattern). Owner
approved the approach (Gate-6). Changes:

- NEW `apps/web/src/lib/csp.ts` — single source for the CSP. PROD `script-src
'self' 'nonce-<v>' 'strict-dynamic'` (NO `unsafe-*`); DEV unchanged
  (`'unsafe-inline' 'unsafe-eval'` for Fast Refresh/HMR).
- `apps/web/src/middleware.ts` — mints a per-request nonce (`btoa(crypto.randomUUID())`,
  edge-safe), sets the CSP on BOTH the request headers (Next nonces its inline
  scripts) and every response (`applyCsp` over the redirects + the next-intl
  pass-through, rebuilt via `new NextRequest(req.url, { headers })`).
- `apps/web/next.config.ts` — CSP removed from static `securityHeaders` (the 4
  non-nonce headers stay); a static header can't mint a per-request nonce.
- `apps/web/src/middleware.spec.ts` — M10\* rewritten to assert the new mechanism
  behaviorally (`buildScriptSrc`/`buildCspHeader`) + CSP-no-longer-static + R2
  connect-src lock-step.

**Verified (real browser, prod `next start`):** login page RENDERS, form present,
`self.__next_f` populated (6), console 100% clean (0 CSP violations / 0 errors);
within a single response ALL 19 script tags incl. the inline `self.__next_f`
bootstrap carry the SAME nonce matching the response CSP header. Tests: middleware
46/46, proxy-CSP 25/25, typecheck + lint clean. **@security-reviewer: PASS**
(0 CRITICAL / 0 HIGH; confirmed root-cause not plaster). Plaster (`'unsafe-inline'`
in prod) was rejected — would gut XSS defense on a PII app.

_Follow-up (non-blocking, from security review):_ tighten M10d so the FE
connect-src must ⊇ ALL browser-fetch hosts the API helmet declares (not just R2) —
today it asserts the R2 subset (same as the original M10b). Also a stale dev MSW
service-worker can independently blank a same-origin prod page in your browser —
clear it (DevTools → Application → Service Workers → Unregister) if a page is blank
after this fix.
