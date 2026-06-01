# EMAPP — Master Plan V12 (Stabilize + Complete)

> The execution plan for everything after the V11 reskin: fix what the two
> audits found, complete the two unbuilt tiers (Provider, Resident), and reach
> production-readiness. Derived from `docs/audit/FINDINGS-REGISTER.md` +
> `STATE-OF-PRODUCT.md` + `PERF-AND-COVERAGE.md` + the owner brief.
>
> **Ordering principle:** unblock first → make gating decisions on day 0 →
> run independent surfaces in parallel tracks → foundation (perf/env) before
> features → verification built into every slice. No slice is "done" until its
> verification test goes red→green and the `apps/web/e2e/audit/*` suite stays
> green (PROC-1/PROC-2 — the fixer never grades their own work).

---

## Tracks (parallel lanes — each can be owned by a separate agent/session)

| Track                 | Surface                                         | Why isolated                                    |
| --------------------- | ----------------------------------------------- | ----------------------------------------------- |
| **A — Core/Perf/Env** | BE infra (`with-tenant`, env, indexes), shared  | Touches every request; one owner, serial within |
| **B — FE fixes**      | `apps/web` forms/routes/copy                    | FE surface; parallel to A (no collision)        |
| **C — Security/ISO**  | auth/portal/logging + ISO mapping               | Gated on DEC-2/DEC-3                            |
| **D — Architecture**  | Provider console + onboarding + tier completion | New surface; gated on DEC-1                     |
| **E — Cleanup**       | dev hygiene, opportunistic                      | Fold in anytime                                 |

Tracks A and B run **simultaneously** (BE infra vs FE) — that is the main
efficiency lever. C and D unlock once their decisions land.

---

## Decision gates (owner-driven — start day 0, they unblock whole tracks)

| ID    | Decision                                                                                           | Unblocks            | How                     |
| ----- | -------------------------------------------------------------------------------------------------- | ------------------- | ----------------------- |
| DEC-1 | **D.NN provisioning model** (who creates whom; invite-token vs share vs OTP vs Provider-initiated) | Track D             | I draft → you approve   |
| DEC-2 | **SEC-1**: may a resident see their own un-masked national-ID?                                     | C1                  | You decide              |
| DEC-3 | **ISO-SCOPE**: in-scope controls / SoA from ISO auditor                                            | C7 + security depth | You obtain from auditor |

---

## Milestones (ordered) with slices

Each slice: **ID · goal · depends-on · verification (red→green test)**.

### G0 — Infra gates (FIRST — these structurally prevent the mess we hit)

The three controls below are the cheapest, highest-ROI work in the plan.
They make the verification contract (PROC-1/2) _mechanical_ instead of
discipline-dependent: an unverified or self-graded PR becomes impossible to
merge, not just discouraged. Land these before any fix slice — every later
PR then rides on them.

| Slice    | Goal                                                                                                                                                                                                                                                                                             | Verification                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0.1** | **Branch protection + required CI checks** on `main`: require `typecheck`, `test`, `e2e`, `lint`, `conformance`, `build`, `audit`, `secrets-scan` green + ≥1 approving review + branch up-to-date-with-main before merge. No force-push to main.                                                 | A PR with a red check (or stale branch) is **blocked from merge** in the GitHub UI. This directly prevents the #167/#168/#134-merged-while-red situation + the stale-branch breakage. |
| **G0.2** | **CODEOWNERS** — auto-assign reviewers + require their approval on sensitive paths: `apps/api/src/common/authz/policy.ts` (Gate-6) → owner; `packages/shared-types/**` → owner; `packages/db/migrations/**` → owner; each track's surface → that track. Encodes PROC-1 "implementer ≠ approver". | Touching policy.ts / shared-types / migrations auto-requests the owner and **blocks merge** without their review.                                                                     |
| **G0.3** | **`security-review` + `code-review` skills run per PR** before merge — `security-review` mandatory on any PR touching auth / policy / PII / export / portal (ISO-relevant); `code-review` on the rest. Findings posted as inline PR comments.                                                    | Each qualifying PR has a recorded security-review/code-review pass attached; a CRITICAL finding blocks merge until resolved.                                                          |

> Why first: G0.1+G0.2 are ~10 min of GitHub config each; G0.3 is per-PR
> habit. Together they make "merge a red/self-graded PR" mechanically
> impossible — the single structural fix for the failure mode that created
> this whole backlog. (G0.1 = the "CI as the objective verification gate"
> that also solves the local-machine-melt problem: the heavy `e2e`/audit
> suite runs in CI, never on the operator's machine.)

### M0 — Foundation & unblock (day 0–2)

| Slice | Goal                                                                                 | Depends | Verification                                      |
| ----- | ------------------------------------------------------------------------------------ | ------- | ------------------------------------------------- |
| A1    | **ENV-1**: fix turbo strict-env so `infisical run -- pnpm dev` boots a healthy stack | G0      | fresh `pnpm dev` → API 200 + login works          |
| B1    | **FUNC-2**: merge dashboard-stats (PR #134) — real KPIs/per-project numbers          | A1      | KPI E2E asserts 5/3/3/2 + project card units/sigs |
| —     | Kick off DEC-1/2/3 in parallel                                                       | —       | decisions recorded                                |

### M1 — Perf core + user-blocking FE (Track A ‖ Track B)

**Track A (BE infra):**
| Slice | Goal | Depends | Verification |
| --- | --- | --- | --- |
| A2 | **PERF-1**: collapse `withTenant` session setup to 1 round-trip | A1 | round-trip-count test ≤2/call; owners-list timing drop |
| A3 | **PERF-2**: stop SSR blocking on `getMe` (cache/client-load) + timeout | A1 | authenticated SSR TTFB test; no per-render self-hop |
| A6 | **PERF-5**: dev `API_BACKEND_URL=127.0.0.1` / ipv4-first | A1 | dev connect-time |

**Track B (FE), parallel:**
| Slice | Goal | Depends | Verification |
| --- | --- | --- | --- |
| B2 | **FUNC-1**: owner-email empty-string + sweep all optional+formatted fields | A1 | owner-no-email E2E green + field-sweep test |
| B3 | **FUNC-3**: `/he/buildings` + `/he/apartments` friendly redirect/404 | A1 | route returns redirect, not raw 404 |
| B4 | **FUNC-4**: login hydration guard (no silent no-op submit) | A1 | fast-fill login E2E |
| B5 | **UX-3**: remove slice jargon ("A.S12","Phase 2") from UI | A1 | grep UI strings — none |

### M2 — Perf finish + Security (Track A ‖ Track C; C needs DEC-2/3)

**Track A:**
| Slice | Goal | Depends | Verification |
| --- | --- | --- | --- |
| A4 | **PERF-3**: composite cursor index on projects+documents | A1 | EXPLAIN = index scan, not Sort; migration up/down |
| A5 | **PERF-4 / UX-1**: TanStack no-4xx-retry + capped backoff | A1 | forced-500/404 error shown <1.5s |

**Track C (gated):**
| Slice | Goal | Depends | Verification |
| --- | --- | --- | --- |
| C1 | **SEC-1**: portal PII per DEC-2 (mask or document) | DEC-2 | portal masking test |
| C2 | **SEC-2**: verify pino PII redaction live | A1 | PII request → grep logs, no cleartext |
| C3 | **SEC-3**: exercise provider MFA gate (forged TOTP) | A1 | MFA-gate E2E |
| C4 | **SEC-5**: refresh rotation / reuse-detection test | A1 | reuse old refresh → revoked |
| C5 | **SEC-4**: CSRF posture — document or add token | A1 | cross-origin POST test + decision |
| C6 | **SEC-6**: public-sign rate-limit test | A1 | 6th sign attempt → 429 |
| C7 | **ISO mapping + evidence collection** | DEC-3 | controls × evidence matrix |

### M3 — Architecture build (Track D; gated on DEC-1; grew per D.43 + D.45)

| Slice           | Goal                                                                                                                                                                                                                                                                                  | Depends | Verification                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| **D0 (canary)** | **Permission model (D.43)**: Agent capability matrix (6 toggles: edit-project-data / manage-documents / manage-signatures / manage-tasks / run-imports / view-owners-masked) + Contractor per-share scope, JSONB, **server-enforced (D.17)**, **IDOR-safe download**                  | DEC-1   | matrix E2E: each toggle on→capability allowed, off→403; contractor download of in-share doc→200, out-of-share id→404 |
| ~~D0.5~~ → PL   | **admin.emapp.io subdomain — DEFERRED to pre-launch (D.56).** Build the Provider console **in-place** (`/provider/*`) now; the separate Pages app + cookie-scope isolation cutover is a launch-blocking PL step tied to the domain purchase. (Was "build early"; corrected per D.56.) | domain  | provider login on admin subdomain; cookie not shared — **verified at PL cutover**                                    |
| D1              | **ARCH-2**: Provider→Org onboarding (create org + first-manager invite)                                                                                                                                                                                                               | —       | provider-creates-org E2E → manager invite → password → login own tenant                                              |
| D2              | **ARCH-1**: Provider console (customer list/detail, audit, settings)                                                                                                                                                                                                                  | D1      | console E2E per capability                                                                                           |
| D3              | **ARCH-3**: per-customer config / "control the values"                                                                                                                                                                                                                                | D2      | config E2E per customer                                                                                              |
| D4              | **ARCH-5**: Contractor portal (read + download, scope per D0)                                                                                                                                                                                                                         | D0      | contractor portal E2E: sees only shared scope, downloads only in-share docs, no PII                                  |
| D5              | **ARCH-6**: Resident portal completion (progress view + full design set)                                                                                                                                                                                                              | —       | resident portal full-feature E2E                                                                                     |

> Track D is the longest. **D0 (permission model) is the canary** — it proves
> the JSONB capability pattern + server-side enforcement + IDOR-safe download
> before the rest. **TDD-from-spec required** (no audit test exists for these
> net-new tiers — write the spec-derived test first; Verifier confirms it
> asserts real behavior, per ORCHESTRATION §5.5).

### DV — Exploratory "as a user" integration verification (after D2/the tiers are built)

The per-slice 4-axis smoke + CI e2e prove **mechanical correctness** (a scripted
flow passes). They do **not** catch "dead button / janky / doesn't behave as a
user expects" — exactly the PROC-2 class the owner flagged. So once the new-tier
UI is in (end of D2), a **dedicated exploratory pass drives the LIVE app**, not
scripted assertions:

| Slice  | Goal                                                                                                                                                                                                                                                                                                                                                                                                              | Verification                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DV** | Drive the running app **as each role** (Provider · Manager · Agent[per-capability] · Viewer · Contractor · Resident) through every key flow, **plus the multi-actor lifecycle** (manager sends a doc to signature → resident receives via OTP → signs → it syncs back → manager sees it). Agent-driven (Playwright **headed** / browser tools) **reading console + network + server logs**, or human walkthrough. | a written report per role + lifecycle: what behaves, what's a dead-button/jank/broken-flow, with the log/screenshot evidence — NOT "looks fine". Findings become fix slices. |

> This is the "real verification, not claimed" pass (PROC-2). It runs **after D2**
> (first time the full app exists) and again, comprehensively, at **PL2**.

### M4 — Coverage close + cleanup (Track E + leftovers)

| Slice | Goal                                          | Verification                 |
| ----- | --------------------------------------------- | ---------------------------- |
| E1    | **ENV-2**: dev DB reset script                | reset → clean counts         |
| E2    | **ENV-3**: seed valid IL phone prefix         | OTP works on seeded resident |
| B6    | **UX-2**: loading skeletons (no layout shift) | CLS check                    |
| B7    | **FUNC-5**: confirm/fix owner-detail empty    | owner-detail content E2E     |

### Pre-launch — final truth

| Slice | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Verification                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PL1   | **PERF-6**: `next build && next start` + **colocated DB** (T6 — Railway region = Neon region; the deferred latency fix from **D.52**, see `SETUP-EXTERNAL-SERVICES.md` step 4). **Also do the deferred PERF-2 fix here (D.53):** SSR `getMe` calls the backend directly instead of self-hopping its own proxy + server-side timeout — verify on the real Cloudflare→Railway topology. **And the admin.emapp.io cutover (D.56):** move the Provider console to the separate Pages app + scope `provider_access_token` to the subdomain (cookie isolation, D.48). | production-absolute ms numbers; per-hop ~138ms→~1ms; SSR getMe: no self-hop; provider cookie scoped to admin.emapp.io |
| PL2   | Full `e2e/audit/*` suite green + the **comprehensive exploratory "as a user" pass** (the full DV sweep — every role + every multi-actor lifecycle on the prod-built app, reading console/network/server logs), per V11-BROWSER-SMOKE                                                                                                                                                                                                                                                                                                                            | all green, raw per-role + lifecycle evidence (logs/screenshots) — not "looks fine"                                    |

---

## Dependency graph (critical path)

```
A1 (ENV unblock) ──┬─> A2 ─> A4 ──┐
                   ├─> A3        ├─> PL1 ─> PL2
                   ├─> A5        │
                   └─> B1..B5 ───┘
DEC-2 ─> C1                       (C2..C6 need only A1)
DEC-3 ─> C7
DEC-1 ─> D1 ─> D2 ─> D3
        └─> D4
D5 (independent) ────────────────> PL2
```

Critical path = **A1 → A2/A3 (perf core) → PL1 → PL2**. Everything else
parallelizes around it. The two longest serial chains are perf-core (A) and
the provider build (D1→D2→D3); run them on separate tracks from the start.

---

## How to run each slice (the loop — same for every track)

1. Branch from main. Read the finding row + its evidence artifact.
2. Write/locate the **verification test first** (it should fail now). If the
   audit already wrote it (`e2e/audit/*`), use that — you didn't write it, so
   it's objective.
3. Fix the root cause (not a patch).
4. Run: the slice's test red→green + the **full** `e2e/audit/*` suite stays
   green + `pnpm lint && pnpm typecheck && pnpm test`.
5. PR with the mechanical evidence (trace/curl/query-plan, not "verified ✓").
6. Self-merge per the autonomous rules **only** when all green; else STOP.
7. Heartbeat: what shipped, decisions self-made, next slice.

Verification contract (PROC-1/PROC-2): a fix is done when an **independently
written** test goes green. Re-running the full audit suite at any time is the
real-state dashboard — no trust required.

---

## Efficiency notes

- **Do A2+A3 early.** They touch every request — once the stack is fast, all
  later testing and demos run on the fast version. Highest leverage.
- **A and B in parallel from M1** — different surfaces, no merge collisions.
- **Make DEC-1/2/3 on day 0** — they gate whole tracks (C, D). Don't let them
  sit; a 1-day decision delay stalls a multi-day track.
- **D5 (resident portal) is independent** — can start anytime in parallel.
- **Don't build Provider console (D2) before D1 onboarding** — D2 is where
  onboarding lives; D1 defines the data flow it renders.
- **ISO (C7) is requirements-driven** — without DEC-3 it's guesswork; the
  rest of Track C (C2–C6) needs only A1 and can proceed.
