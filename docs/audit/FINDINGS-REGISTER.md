# EMAPP — Consolidated Findings Register

> Single source of truth for all known problems. Consolidates: the owner's
> problem brief, `STATE-OF-PRODUCT.md` (functional audit), and
> `PERF-AND-COVERAGE.md` (perf + coverage follow-up). Deduplicated.
>
> **How to read:** every row has a fix approach AND a **verification method**
> — the mechanical test that proves it's fixed (red before, green after).
> A fix is "done" only when its verification goes green AND the rest of the
> `apps/web/e2e/audit/*` suite stays green (no regression). The fixer never
> grades their own work — the audit's specs (written by an independent pass)
> are the contract.
>
> Severity: BLOCKER (stops work/launch) · HIGH (blocks a user or a goal) ·
> MEDIUM · LOW. Status: OPEN unless noted.

---

## Tier / architecture state (the 3-entity model)

| Tier                         | Who                                                                                             | Built?                                                    | Gap                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| **Provider** (product admin) | SaaS operator. Own login + MFA, no signup, manages customers/audit/settings/per-customer-config | **Shell** — login + a few BE endpoints + UI scaffold only | ARCH-1, ARCH-2, ARCH-3        |
| **Org** (customer)           | Manager (full, tenant-only) / Agent (assigned-only) / Viewer (read) / Contractor (read, share)  | **Built (Manager strong)**                                | Agent/Contractor under-tested |
| **Resident** (דייר)          | OTP, own-data-only, sign on request. Periphery audience                                         | **Core works** (OTP + signature)                          | broader portal under-audited  |

Provisioning model (who creates whom) — **decision pending, see ARCH-4 / D.NN**.

---

## PERF — performance & scale (owner pain #1)

> Key nuance: all measured numbers are **dev mode** (remote Neon @138ms/round-trip
>
> - Windows localhost-IPv6 tax). Production with a colocated DB collapses the
>   absolute ms. The durable problem is **round-trip COUNT**, which caps throughput
>   ("many customers") in every environment.

| ID     | Sev        | Finding                                                                                                                                             | Fix                                                                                                               | Verification                                                                                                  |
| ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| PERF-1 | HIGH       | `withTenant` issues 4–6 un-pipelined Neon round-trips per call (BEGIN/SET ROLE/set_config×3/query/COMMIT). Biggest lever; caps throughput at scale. | Collapse session setup into 1 multi-statement round-trip; drop separate COMMIT round-trip for reads.              | Instrument round-trips per API call; assert ≤2. Re-run `owners?limit=25` timing, assert drop.                 |
| PERF-2 | HIGH       | `getMe` SSR self-fetch (browser→Next→API) blocks every authenticated page HTML (~460ms dev); deadlocks dev server under load, no timeout/fallback.  | Cache session-validity (short TTL) / client-load user / bypass proxy self-hop (§v9-M-9). Add server-side timeout. | SSR TTFB test on authenticated page: assert no per-render self-hop (or cached) + fast-fail under stalled /me. |
| PERF-3 | MED        | `projects` + `documents` list pagination lacks `(org_id, created_at DESC, id DESC)` index → whole-org Sort at scale (owners/tasks have it).         | Add the composite partial index `WHERE archived_at IS NULL`.                                                      | EXPLAIN shows index-ordered scan, not Sort node. Migration up/down test.                                      |
| PERF-4 | MED        | Error feedback takes 7–9s (TanStack retry×3 + backoff, retries non-retryable 4xx).                                                                  | Don't retry 4xx; cap backoff; show error after 1 attempt for non-network.                                         | Forced-500 + forced-404 E2E: assert error shown <1.5s.                                                        |
| PERF-5 | LOW (dev)  | localhost IPv6 tax (~60–200ms/hop) inflates dev/demo feel.                                                                                          | `API_BACKEND_URL=http://127.0.0.1:3000` in dev / `--dns-result-order=ipv4first`.                                  | Dev connect-time measurement.                                                                                 |
| PERF-6 | — (action) | No production-representative absolute numbers — everything dev.                                                                                     | `next build && next start` + colocated DB pass.                                                                   | The pass itself (final ms).                                                                                   |

---

## SEC — security & ISO 27001 (owner pain #2)

> Headline from the audit: **no CRITICAL findings; server-side fundamentals are
> solid** (RLS isolation, JWT integrity, server-side RBAC, rate-limit,
> mass-assignment rejection, PII masking). Below are the residuals + the one new
> finding. ISO work is **gated on getting the auditor's control scope** (ISO-SCOPE).

| ID        | Sev                    | Finding                                                                                                                                             | Fix / decision                                                                                 | Verification                                                  |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ISO-SCOPE | BLOCKER (for SEC wave) | ISO 27001 in-scope controls / Statement of Applicability not yet obtained.                                                                          | **Owner action:** get control scope from the ISO auditor.                                      | n/a — input.                                                  |
| SEC-1     | MED                    | `/portal/me` returns resident's own `nationalId` + `phone` in CLEARTEXT, while org-side masks them (D.19). Own data, not a leak — but inconsistent. | **Product decision:** may an owner see their own un-masked national-ID? If not, mask here too. | Portal response masking test (after decision).                |
| SEC-2     | MED (A.12)             | PII-in-server-logs not verified live (pino redaction configured, unconfirmed at runtime).                                                           | Confirm redaction; fix gaps.                                                                   | Trigger PII requests, grep server logs, assert no cleartext.  |
| SEC-3     | MED (A.9)              | Provider MFA enforcement not exercised (tier is a shell).                                                                                           | Exercise via forged TOTP session.                                                              | End-to-end MFA-gate test on provider login.                   |
| SEC-4     | LOW (A.9)              | Refresh-token rotation / reuse-detection (D.21) asserted by design, not re-tested.                                                                  | — (verify only).                                                                               | Reuse old refresh token → assert revoked + chain invalidated. |
| SEC-5     | LOW                    | CSRF relies on SameSite=Lax + custom header; no anti-CSRF token.                                                                                    | Document decision (acceptable for cookie+SameSite) or add token.                               | Cross-origin POST test + recorded decision.                   |
| SEC-6     | LOW                    | Public-sign POST rate-limit (5/hr) not stress-tested.                                                                                               | — (verify only).                                                                               | Rate-limit test (careful: burns single-use token).            |

---

## FUNC — functional bugs (buttons/data)

| ID     | Sev            | Finding                                                                                                                                                                            | Fix                                                                                                  | Verification                                                                              |
| ------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| FUNC-1 | HIGH           | Cannot create an owner without email via UI — `email: .email().nullable().optional()` rejects the empty string the form sends. **Likely a class:** every optional+formatted field. | FE `setValueAs "" → undefined`, or schema `.or(z.literal(''))`. Sweep all optional-formatted fields. | Audit's failing owner-no-email spec → green. Sweep test across optional-formatted fields. |
| FUNC-2 | HIGH (product) | Hollow dashboard — 4 KPI cards + per-project stats show `—`, no live data, no drill-down. First screen conveys nothing.                                                            | Already wired in PR **#134** (BE aggregates + `/api/v1/org/stats` + FE). Merge after verify.         | Dashboard KPI E2E asserts real numbers (5/3/3/2 on seed) + project card units/signatures. |
| FUNC-3 | LOW-MED        | `/he/buildings` + `/he/apartments` bare-URL → 404, no friendly handling.                                                                                                           | Redirect to parent or friendly 404.                                                                  | Route returns redirect/friendly page, not raw 404.                                        |
| FUNC-4 | LOW-MED        | Login hydration race — fast-fill before RHF hydrates → silent no-op submit.                                                                                                        | Wait-for-hydration guard / disable submit until ready.                                               | Fast-fill login E2E (the audit's guard reproduced it).                                    |
| FUNC-5 | LOW (confirm)  | Owner detail page rendered empty content in screenshot (inconclusive).                                                                                                             | Investigate then fix if real.                                                                        | Human/Playwright confirm owner-detail content.                                            |

---

## UX — error handling, jank, polish (don't change design, improve existing)

| ID          | Sev | Finding                                                                                                            | Fix                                  | Verification                                 |
| ----------- | --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------- |
| UX-1        | MED | Slow error feedback (7–9s) — same root as PERF-4.                                                                  | (see PERF-4)                         | (see PERF-4)                                 |
| UX-2        | LOW | Loading is text-only (`טוען...`), no skeleton → layout shift when content replaces it.                             | Add skeletons matching final layout. | Visual / CLS check.                          |
| UX-3        | LOW | Internal slice jargon leaks to production UI ("A.S12 (Calendar + ICS)", "Phase 2").                                | Replace with user-facing copy.       | Grep UI strings — no slice IDs / phase refs. |
| UX-positive | —   | RTL + spacing clean; errors localized Hebrew, never leak stacks; cached nav is instant (TanStack staleTime). Keep. | —                                    | —                                            |

---

## ARCH — tiers, permissions, provisioning

| ID     | Sev            | Finding                                                                                                   | Fix / decision                                                                                                                                                                 | Verification                                                                            |
| ------ | -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| ARCH-1 | HIGH           | Provider tier is a shell — console (customer management, audit, settings, per-customer config) not built. | Build provider console (gated on D.NN). May add to design if integrated.                                                                                                       | Provider console E2E per capability.                                                    |
| ARCH-2 | HIGH           | Provider→Org onboarding missing — org + first manager only via `withBootstrap` script, no UI/flow.        | Provider Admin form → creates org + sends first-manager invite-token (own-password). Gated on D.NN.                                                                            | Provider-creates-org E2E → manager gets invite → sets password → logs in to own tenant. |
| ARCH-3 | MED            | Per-customer config / "control the values" — needs design.                                                | Part of provider console; design pass.                                                                                                                                         | Config E2E per customer.                                                                |
| ARCH-4 | **RESOLVED**   | Provisioning model (who creates whom).                                                                    | **Closed by D.42** (DECISIONS-V12) — invite-token for org staff, Provider-initiated invite for Org onboarding, share-link for contractor, OTP for residents; no shared secret. | Decision recorded — D.42.                                                               |
| ARCH-5 | MED (coverage) | Contractor share-scope never exercised.                                                                   | — (test).                                                                                                                                                                      | Contractor share E2E: read-only on correct scope only.                                  |
| ARCH-6 | MED (coverage) | Resident portal beyond OTP+signature not fully audited (progress view, full design feature set).          | — (test) + build missing.                                                                                                                                                      | Resident portal full-feature E2E.                                                       |

### D2 close-out — built + deferred (audited 2026-06-01)

**D2 shipped (5 of 6 tiers complete):** Provider console (suspend/reactivate +
onboarding) · Agent capability UI · reveal-on-demand PII button · Resident portal
(D.47 masking + aggregate progress) · contractor share-default fix. #201–207, all
audited (Gate-6 holds — no policy/migration; security properties verified).

**Deferred (tracked so they don't fall through):**

| ID       | Sev      | Finding                                                                                                                                                                                                                                                                                                                                               | Where               |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| D2-DEF-1 | MED      | **Contractor read-tier not built** — share-permission defaults + `signatureScopeForShare` helper exist (owners-PII OFF, aggregate-only), but the contractor **auth tier + read endpoints + read-view UI** are not. The D.46 enforcement lands on those endpoints when they ship. So the Contractor is the one tier not consumption-complete after D2. | Track D-future / C  |
| D2-DEF-2 | LOW (UX) | **AccessReasonGate length mismatch** — FE gate min 8 chars; `withProvider` rejects reasons < 20 (unless ticket ref) → operator with an 8–19-char non-ticket reason passes the gate but the provider write fails generically. Pre-existing; tighten the FE gate to match the BE.                                                                       | Track C / quick fix |
| D2-DEF-3 | LOW (UX) | **Reveal-PII button shown to capability-less agents** — button renders for role=agent even without `view_owner_pii` (BE 403 is the real gate → no security issue, but a dead-click). Needs `UserProfile` to carry capabilities to hide precisely.                                                                                                     | Track C / quick fix |

---

## ENV — dev tooling / hygiene

| ID    | Sev        | Finding                                                                                                                                                                    | Fix                                                           | Verification                                                                |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ENV-1 | HIGH (dev) | Turbo strict-env-mode filters secrets → documented `pnpm dev` boots a broken stack (SIGNATURE_TOKEN_SECRET, API_BACKEND_URL dropped; API silently dead, login impossible). | `globalEnv`/`passThroughEnv` additions or `--env-mode=loose`. | Fresh `infisical run --env=dev -- pnpm dev` boots healthy stack; login 200. |
| ENV-2 | LOW        | Shared dev DB accumulated 46k owners / 167 provider_users, no reset routine.                                                                                               | Add a dev reset script.                                       | Reset → clean counts.                                                       |
| ENV-3 | LOW        | `seed-volume` generates invalid `051` phone prefix → unusable for OTP.                                                                                                     | Valid IL mobile prefix.                                       | OTP works against seeded resident.                                          |

---

## PROCESS — testing objectivity & verification standard (owner pain)

| ID     | Sev | Finding                                                                     | Standard going forward                                                                                                                                                       | Status                                                          |
| ------ | --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| PROC-1 | —   | Prior tests were biased — agents tested their own code (tautological pass). | Tests assert from **spec/DECISIONS**, not from code. The independent `apps/web/e2e/audit/*` specs are the regression net; a fix = its failing spec → green, by a non-author. | **Pattern established** by the two audits; enforce permanently. |
| PROC-2 | —   | "Works" was claimed without real verification.                              | Manual/E2E must drive the real stack: actual clicks, real network/console/server-response capture, mechanical artifact per claim. No "verified ✓" without paste/trace.       | **Established**; enforce per V11-BROWSER-SMOKE.                 |

---

## Wave sequencing (dependency-respecting default — owner sets final order)

| Wave                            | Theme                             | Items                                                       |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| **0 — Unblock**                 | Anyone can run the stack          | ENV-1                                                       |
| **1 — User-blocking**           | What the customer sees broken now | FUNC-1, FUNC-2 (PR #134), FUNC-3, FUNC-4, UX-3              |
| **2 — Security / ISO**          | Compliance (gated on ISO-SCOPE)   | SEC-1 (decision first), SEC-2, SEC-3, SEC-5, SEC-4, SEC-6   |
| **3 — Perf / scale**            | "Many customers" goal             | PERF-1, PERF-2, PERF-4/UX-1, PERF-3, PERF-5                 |
| **4 — Architecture / coverage** | Complete the tiers                | D.NN (ARCH-4) → ARCH-2, ARCH-1, ARCH-3, ARCH-5, ARCH-6      |
| **Pre-launch**                  | Final truth                       | PERF-6 (prod-build + colocated DB), full audit-suite re-run |

Cross-cutting: PROC-1/PROC-2 are the verification contract for **every** wave.
ENV-2/ENV-3 + FUNC-5/UX-2 are low-priority cleanups, fold in opportunistically.

---

## Decisions — RESOLVED (see DECISIONS-V12.md, D.45–D.50)

Provisioning → **D.45** · Agent matrix + Contractor read+download → **D.46** ·
Resident PII masked → **D.47** · admin subdomain → **D.48** · Provider write
actions → **D.49** · export = read projection → **D.50**. Still pending:
ISO-SCOPE (from auditor — procurement) + wave4 H-3/C-2/M-7 (defaults recorded).

---

## Reconciliation with the manager-be + export audits (added after the full sweep)

A self-verification sweep recovered 5 audit docs from git history + read 6 more
(QA-MANUAL, handoffs, heartbeats). ~30 additional findings surfaced. **Crucially,
a large share were already CLOSED or QUEUED in `main` by autonomous wave work
while this register was being written** — do NOT re-open them:

- **Wave 1 (shipped):** errors-C-1, H-5, H-6, M-3, M-5, L-2, L-3.
- **Wave 4 (shipped):** M-1 tenant_sessions (TTL 30→10, migration 0038).
- **Wave 5 (shipped — all 5 export CRITICALs):** EXP-C1 (formula injection),
  E-C1/E-C2 (audit split + PII heap drop), E-C3 (D.16 message), PDF-Chromium
  perf (1.5s→0.5s). PRs #155–#158.
- **Wave 6 (planned, queued):** the export HIGHs — EXP-H1/H2/H3, E-H1..E-H4.

Full detail lives in the audit docs now in `main`:
`docs/audits/2026-05-27-manager-be-{redteam,perf,errors}.md`,
`docs/audits/2026-05-28-export-{errors,perf,redteam}.md` + `-wave5-closeout.md`,
`QA-MANUAL-FINDINGS.md`.

**Still genuinely OPEN after wave5/6** (the real V12 backlog):

- **password-reset flow missing** (HIGH) — no recovery path exists at all.
- **PERF-1** withTenant round-trip collapse · **PERF-2** getMe SSR (§v9-M-9).
- **redteam-H-1** member-revoke does not kill live tokens (15-min window).
- **ARCH-1/2** Provider console + onboarding (now unblocked by D.49).
- **D.46** permission matrix (Agent capabilities + Contractor scope) — net-new.
- **EXP-M3 / D.50** export PII-fidelity per actor — folds into export work.
- FUNC-1 owner-email · FUNC-3 routes · FUNC-4 hydration · UX skeletons/jargon.

> Lesson encoded: this register is a snapshot. Before acting on any row, check
> `main` — autonomous waves may have already closed it. That check is exactly
> what surfaced this reconciliation (and prevented re-doing wave5).
