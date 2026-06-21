# 00 — FINAL E2 BUILD PLAN (the owner's greenlight artifact)

> **Status:** DEFINITIVE go/no-go build artifact. The single, dependency-ordered,
> gap-closed plan the owner builds from end-to-end. READ-ONLY planning doc — no app
> code changed by this document. Author: Production-readiness synthesis seat, 2026-06-18.
>
> **What this is.** The merge of three layers into one buildable plan:
> 1. **The design roadmap** — `v3-coverage/00-FINAL-ROADMAP.md` (38 slices, every design/coverage gap homed).
> 2. **The production-readiness audit** — `v4-readiness/00-PRODUCTION-READINESS.md` + the 4 fronts
>    (`01-api-action-map`, `02-long-flows`, `03-engineering-quality`, `04-scale-control-redteam`), adding **17 production/control/engineering gaps (N1–N17)**.
> 3. **The locked law** — `v2/DECISIONS-LOCKED.md` (D.1–D.5) · `docs/DESIGN-NORTH-STAR.md` (doctrine) · `docs/SECURITY-POSTURE.md` (P0/P1/P2 program).
>
> **How to read this.** Waves run top-to-bottom; slices inside a wave parallelize unless a
> dependency is noted. Every slice carries **name · what · the real files/endpoints · BE/FE · its gate**.
> Owner/legal/ops-gated slices are flagged **🔒**. The binding rules (§A) and the universal DoD (§A)
> are non-negotiable on every slice. The four CRITICAL audit items are **front-loaded** (§C).
>
> **The headline (from the v4 audit).** The plan is design-complete and the engineering substrate
> is genuinely production-grade (4-layer RLS isolation, owned auth, atomic idempotency, a **real
> pg-boss cron scheduler already running 3 sweeps**, a self-verifying forensic spine, an atomic
> org-suspend kill-switch). It is **not yet CONTROL-complete**. The four certainty-gate defects:
> `projects.update()` is any→any with no concurrency check (N1+N2); the consent number is binary
> by-heads not share-weighted and the legal boolean rides on it (N4); the clock cleans up but never
> chases (N3); and there is no operator-recovery console (N5). All four are small, unblocked, and
> the infra to build them already exists. **Verdict: `material-control-gaps` — production-ready
> AFTER the bounded additions below.**

---

## A. The binding rules + universal DoD (apply to EVERY slice — no exceptions)

### A.1 — The interim consent-basis-label rule (the single most important written rule)
Until the statutory basis is legally confirmed (🔒 OD-1, §H), **no slice may render an unqualified
consent % as a legal or threshold claim.** Every % carries its denominator label ("לפי שיעור הבעלות"
vs "לפי ראשי דירות") and leads with the plain-Hebrew count sentence ("23 מתוך 40 דירות חתמו" — *not*
a legal claim). Board-first, the print artifact (C1), the threshold celebration (M3), and the tenant
portal all inherit this rule. **D.1 locked share-weighted** as the headline basis; only the exact
statutory % stays legal-gated.

### A.2 — The DO-NOT-FABRICATE register (binding on every FE slice)
Never render a signal the backend cannot honestly back:
- "נזכיר שוב בעוד N ימים" / any future-nudge → ❌ FORBIDDEN until **B3** ships (the scheduler exists
  but emits no chase notification today). Ship the honest past-tense "נשלחה תזכורת לאורי" only.
- "N בעלים מתנגדים" / objection count or reason → ❌ FORBIDDEN until **B2**. Substitute
  "X דירות סומנו כסירוב" from `apartments.status` if a "why" is wanted.
- "+N השבוע" / "אין תנועה N יום" / pulse buckets / forecast → ❌ omit until **B1**.
- The holdout's NAME ("אורי") → ❌ until **B4**; show "דירה 7 · partial" meanwhile.
- "שלחנו N תזכורות אתמול" / any "the system acted" claim → ❌ until **B3**.
- **Campaign "נשלח ל-N" → must show the `failed` count too (N7)** — never report "sent" when the
  backend computed a per-owner failure. The doctrine's inverse: always surface a failure the backend DID detect.
- Any unqualified consent % → ❌ always until OD-1 (rule A.1).

### A.3 — The universal Definition of Done for EVERY slice
`pnpm typecheck && pnpm lint && pnpm test` green — **including** the inline-color ratchet
(`app-no-new-inline-colors.spec.ts`), the **class-name leak guard** (Wave 0), the **input-validation
-coverage guard** (S0-SEC), `app-forms-no-get-fallback.spec.ts`, and adapter/sidebar specs — **AND**
a real-Chrome **4-axis verify** (Network / URL / Cookies / Redirect, `docs/DOD-BROWSER-SMOKE.md`)
**per affected role** — **AND** a **perf-budget check** (warm 200ms; the seeded-50-project gate where
the slice touches `orgStats`/`signatureProgress` — see N9/PERF) — **AND** a **North-Star check** (does
this surface *reduce* actions, speak plain Hebrew, never fake a signal, stay re-skinnable?). **Routes
are never deleted** (re-composition, not re-routing). New endpoints add a `gen-api-docs` ENDPOINTS
entry (the api-docs-coverage guard fails CI otherwise) and must land validated by the global pipe (S0-SEC).

---

## B. What changed vs the v3 roadmap (the delta the owner is approving)

The v3 roadmap's **spine is unchanged**: board-first IA, the chase loop, tokens + leak-guard, the
honest BE slices, the DO-NOT-FABRICATE register. The v4 audit folds in **17 production/control gaps
(N1–N17)** that the design coverage did not see. The deltas:

| # | Change vs v3 roadmap | Audit gap |
|---|---|---|
| 1 | **S0-SEC stays FIRST and is now a hard ordering gate** — must land before B0/B1/B4/B5. (No content change; the audit promotes the *enforcement*.) | N12 |
| 2 | **B5 DOUBLED in scope:** was "status-transition state machine" only; now ALSO an **If-Match / `updatedAt` optimistic-concurrency guard** on `projects.update()` (`projects.service.ts:762-816`, confirmed no version predicate on the UPDATE at `:803`). This is the **#1 engineering-below-bar fix** — both halves in ONE slice, before any board-first 'approve' action. | **N1**+N2 |
| 3 | **B0 WIDENED into a wave:** share-weighted CTE **+ fix the tenant/portal denominator** (`adapters/portal.ts` reads 100% when 10/35 signed) in the SAME slice **+ extract a `ConsentCalcService`** (stop growing the god-service) **+ gated behind a NEW perf slice (PERF/N9):** a `cache_kv` layer over `orgStats`+`signatureProgress` + a seeded 50-project perf test B0 must pass to merge. | **N4**+N9 |
| 4 | **B3 RE-SCOPED** from "build a scheduler" (the v3 roadmap's "zero schedulers today / NET-NEW infra" premise is **factually wrong** — all 4 fronts refute it) to "add **1 pg-boss cron consumer + 3 notification kinds** (`expiring`/`stalled`/`threshold_reached`) **+ FE deep-links**." The scheduler already runs 3 sweeps (`apps/worker/src/main.ts`). Materially smaller; de-risks the whole autonomy story. | **N3** |
| 5 | **C12b PROMOTED** from "P1–P2 owner-call scope" to a **GO-LIVE BLOCKER** for the MFA-reset + unlock + resend-invite subset (first weekly MFA lockout otherwise needs a developer with raw DB access). Existing epic: `docs/perf-research/PROVIDER-ADMIN-AUDIT.md`. | **N5** |
| 6 | **NEW slice C16 — headless-route surfacing:** a minimal admin UI for the 15 live API routes with no screen, prioritizing the **legally-mandatory GDPR DSAR** (`owners/:id/data-export`) **+ RTBF** (`owners/:id/erase`) **+ member-overrides PUT/DELETE**. | **N6** |
| 7 | **M5 WIDENED:** surface the per-owner `failed` count + drill-down the backend already computes (`signature-requests.service.ts:482-534`, discarded by the toast) **+ add a campaign PREVIEW/dry-run endpoint** (`POST /projects/:id/signature-campaign/preview`) before fan-out. | **N7**+N8 |
| 8 | **NEW slice C17 — list-level control:** bulk verbs (archive/status/resend) + saved views + cross-project "expiring this week" triage. (Calm-minimal-actions inverts into per-row drudgery at 200 projects without it.) | **N10** |
| 9 | **N11 tabu honesty as an explicit gate:** ship **labeled manual-entry** OR build the real parser — do NOT ship "extraction" over the `StubExtractionProvider` (`extraction-provider.factory.ts:36`). | **N11** |
| 10 | **N13** post-signature `withdrawn` lifecycle (extend B2) · **N14** alerting fails-open → ops checklist + boot assertion + job retry/drain folded into C12b · **N15** a cheap env-gated `CAMPAIGN_SEND_ENABLED` kill-switch NOW · **N16** new-project wizard drops `unitType`/`areaSqm` on the wire (`projects/new/page.tsx:273`) → persist or stop collecting (C5) · **N17** SSE 30-stream cap → LISTEN/NOTIFY noted post-MVP (C8). | N13–N17 |

> **Net:** the v3 spine + the 38 design slices are intact. The v4 delta is **4 critical re-scopes
> (B5 double, B0 wave, B3 re-scope, C12b promote)**, **2 new slices (C16, C17)**, **1 new perf gate (PERF)**,
> and **6 small honesty/ops fixes folded into existing slices (N7/N8/N11/N13/N14/N15/N16/N17)**.

---

## WAVE 0 — Foundation + the security gate (zero screen redesigned; everything depends on it)

> Front-loaded: tokens, the fused live-region, **the security pipe (S0-SEC) and the perf gate (PERF)
> that the consent rewrite depends on**, the tz fix, DataState. No screen is "redesigned" yet — but
> every guard that polices later waves is frozen here.

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **S0-SEC — Global validation pipe + coverage guard** ⭐CRITICAL | Global `APP_PIPE` (`GlobalZodValidationPipe`) + `@ZodBody`/`@ZodQuery` metadata + explicit `@RawBody`/`@NoValidation` markers for the 4 known exceptions (documents `:id/content` raw bytes; auth + provider-auth `refresh`/`logout` cookie-only). NEW CI guard `input-validation-coverage.spec.ts` (static scan of every `*.controller.ts`, modeled on `api-docs-coverage.spec.ts`). + Regression lock `CreateOwnerDto.safeParse({national_id:'123456789'})` fails (P0.3). | `apps/api/src/main.ts`, `app.module.ts`, every `*.controller.ts`, new spec | BE | **N12 — LANDS BEFORE B0/B1/B4/B5/B2** so all new endpoints are validated by construction, not convention. SECURITY-POSTURE P0.1+P0.2+P0.3. |
| **PERF — Cache layer + seeded 50-project perf gate** ⭐CRITICAL-precondition | Add a `PostgresCacheProvider`/`cache_kv` read-through cache over the two hot aggregations — `orgStats` (`projects.service.ts:537-581`) + `signatureProgress` (`:355-435`) — with tenant-scoped keys + invalidation on the relevant writes. Add a **seeded 50-project perf test** (warm < ~200ms / sub-second cold) that **B0 must pass to merge**. (`cache_kv` exists but is wired ONLY for export rate-limit today.) | new cache wiring in `projects.service.ts`; seeded perf spec | BE | **N9 — gates B0:** the share-weighted CTE ADDS GROUP-BY + share math and is heavier than today's binary count. "Sub-second at 50 customers" is currently UNPROVEN. |
| **E2.0 — Tokens** | Tier-2 semantic block + semantic Tailwind mappings + the two missing scales **`--space-1..12`** & **`--text-display..caption`** (Heebo 400/500/700) + fix the 3 shipping bugs: dead `bg-card` (×41 files), contradictory `--r-lg` (12 vs 8px), `borderRadius.lg→var(--r-lg)`. Brand fork → `--brand → --navy-900` (D.5, one-token edit). | `apps/web/src/app/globals.css`, `tailwind.config.ts` | FE | Additive; existing ratchet + typecheck prove it; no screen changes. |
| **E2.0-GUARD — Class-name leak guard (re-measured baseline)** | NEW static guard flagging `(bg\|text\|border\|ring)-(gray\|slate\|zinc\|emerald\|green\|amber\|yellow\|red\|rose\|blue\|…)-[0-9]` in `components/**`+`app/**`. **RE-MEASURE the baseline across the FULL tree FIRST** — incl. the **Provider-Admin subtree** (`provider/**`, `pc-sidebar.tsx`, `provider/system-health` hardcoded `bg-emerald/amber/red`), every `*/new`, every detail form, settings sub-configs, members/overrides panels, contractor share, tenant portal — then freeze at the TRUE count and ratchet DOWN each slice. | new `apps/web/src/*-no-default-palette-class.spec.ts`; full-tree baseline scan | FE | **A8·A9 — must include provider + all forms or it ratchets from a false floor.** |
| **E2.0b — StatusPill + statusColor→intent** | Re-home `status-badge.tsx` + `Button.destructive` onto token `.badge-*`; rename `statusColor:'gray\|amber\|emerald\|red'` → intent `success\|warning\|danger\|info\|neutral` across `models/project.vm.ts:28` + the 6 adapters (`project.ts:48`, `apartment.ts:32`, `signature-request.ts:30`, `task.ts:34`, `import.ts:35`, `portal.ts`) + the 3 specs. | listed VM/adapters/specs, `status-badge.tsx` | FE | `adapters/*.spec.ts` guard the rename; re-skins every list/card at once. |
| **M0+G6 — Unified announcement primitive** | ONE app-root `role="status" aria-live="polite"` (+`assertive`) live-region that is BOTH the `ActionToast` (auto-dismiss, pause-on-hover, undo, concurrent `settle`) AND the a11y G6 region. Migrate the bespoke non-dismissing inline "saved" lines — **enumerate ALL ~11 sites** (6 settings sub-configs + role-editor + member-capabilities/overrides). Follow the `ConfirmDialog` a11y contract (ESC/trap/roles). | new live-region primitive; settings/members feedback sites | FE | Tension-5 fusion. Absorbs coverage B2. |
| **M1 — Motion tokens** | `--motion-duration-{fast,base,slow}` + `--motion-ease-*` + `prefers-reduced-motion` guard (zero durations under `reduce`). No looping animation except the existing skeleton pulse. | `globals.css` | FE | Owned here. Reconcile count-up vs LCP budget (G-MOTION-PERF) before M3. |
| **P-TZ-1 — Relative-time fix + ICU plurals** | `formatRelative` (18 adapters) → pin "now" AND target to `Asia/Jerusalem` before diffing; unit test for a UTC instant near the IDT day boundary. + ICU-plural + native-Hebrew copy ("שתי חתימות"), not dev string concat (absorbs B12/X9). | `apps/web/src/lib/format.ts` + new test; i18n catalogs | FE | Cross-cutting correctness; gates chase-loop honesty. |
| **C2 — `<DataState>` contract** | ONE wrapper: loading skeleton / calm error+retry / **403 access-denied muted, no retry** / guided empty. Wires M0/G6. **Kill "silent null on error"** (`signature-progress-board.tsx` returns bare `null` — confirmed). | new `DataState`; `signature-progress-board.tsx`; `ListSkeleton`/`ListPageShell` | FE | Resolves the "never silent" contradiction. Absorbs C-j offline-banner stub. |

**Wave-0 owner/external decisions to clear here:** 🔒 OD-5 (`en` a real shipping locale?) · 🔒 OD-6 brand
fork (resolved by D.5, confirm) · **doctrine lines** needing an owner stance (C-j): "no session countdown"
UX, PII-egress cue, bidi-interpolation static guard, G-MOTION-PERF (count-up vs LCP budget). · **N15
(cheap, do now):** add an env-gated `CAMPAIGN_SEND_ENABLED` kill-switch in the campaign service — 1-line
surgical insurance below org-suspend.

---

## WAVE 1 — Structural redesign + consent correctness + the integrity gate

> The app starts to *feel* redesigned. **B0 (consent wave) and B5 (the integrity double) are the
> certainty gate** and lead this wave. B0 depends on PERF (Wave 0); B5 depends on S0-SEC (Wave 0).

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **B0 — Share-weighted consent + portal denominator + ConsentCalcService** ⭐CRITICAL 🔒OD-1 | Re-author `signatureProgress` (`projects.service.ts:355-431`, confirmed `:419-421` binary by-heads): replace `apartmentsConsented/totalApartments` with a **share-weighted CTE** reading `ownerships.share_numerator/denominator` (migration 0065, DB-guaranteed sum=1). Add per-building `GROUP BY`, the **partial-share credit decision** (OD-3), and the **SHELL-owner denominator** effect. **Pin the wire-contract:** keep `metThreshold` as THE boolean the FE reads (now share-basis); keep `consentedPct` (by-heads) as a supporting line; add `consentedShare`/`metThresholdByShare` + `byBuilding[]`. **+ FIX THE PORTAL DENOMINATOR (N4) IN THIS SLICE:** `adapters/portal.ts` `signedPct = signaturesSigned/signaturesTotal` reads 100% when 10/35 signed — re-base it on the apartment/share denominator. **+ EXTRACT a `ConsentCalcService`** (stop growing the god-service — N9 SOLID). + re-skin & validate the input surface `apartments/[id]/ownerships/page.tsx`. Migrate the 3 binary-asserting specs. | `projects.service.ts` consent block → new `ConsentCalcService`; `adapters/portal.ts`; `ownerships` schema (read-only); `apartments/[id]/ownerships/page.tsx`; consent specs; `shared-types/src/project.ts` | BE+FE | **🔒 D.1 locked share-weighted — NOT blocked. Exact statutory % + partial-share rule = [LEGAL — owner/lawyer confirm]; ship behind the interim basis-label (A.1) until then. MUST PASS THE PERF GATE (Wave 0).** Closes A1·A2·B5·**N4**. |
| **B5 — Status state-machine + optimistic-concurrency guard** ⭐CRITICAL | TWO halves in ONE slice. **(i) State machine:** replace the unguarded `patch.status = input.status` (`projects.service.ts:773`, any→any confirmed) with allowed transitions over the D.18 enum (planning → gathering_signatures → approved → in_construction → completed; any → cancelled) + a **`metThreshold` precondition for `approved`** (cannot mark approved unless B0's share-basis `metThreshold` is true). Illegal → `{error:{code:'invalid_status_transition'}}`. **(ii) Optimistic concurrency (N1):** the UPDATE at `:803` has NO `updatedAt`/version predicate — add an **If-Match / `updatedAt` precondition** (`UPDATE … WHERE id = ? AND updated_at = ?`), 0-rows → calm `{error:{code:'stale_write'}}` 409. The plan ASSUMES a 409 the code does not emit. Unit tests per edge (illegal transition, below-threshold approve, concurrent clobber). | `projects.service.ts` `update()` (`:762-816`); new transition map; If-Match header plumbing; spec | BE | **N1+N2 — lands BEFORE any board-first "approve / you can file" action wires to it.** No migration. |
| **E2.2-S1 — Board-first tabs** | Flip default `useState('tenants')→'signatures'`, re-order tabs (1 חתימות · 2 מבנה · 3 מסמכים · 4 פעילות · 5 גישה · overflow הגדרות), inline empty-CTA targets. | `project-detail.client.tsx:79`; tab components | FE | Scope = tab DEFAULT + ORDER only (the merger is deferred, §G). Board % carries the basis label (A.1) from first render. |
| **E2-IA-S2 — Sidebar 14→5 + Admin group** | Regroup `sidebar.tsx:113-145`: spine = Home · Projects · Owners (gated `owners.read`) · Imports · Tasks; collapse members/audit/settings → "ניהול/Admin"; demote notes/contractors/messages/signature-requests/documents; drop the redundant notifications nav line (bell stays). **Keep ALL routes.** | `sidebar.tsx`; `(dashboard)/layout.tsx` | FE | Per-role smoke. **Ship S4 search no later than this slice** (no nav-or-search hole, D.4). |
| **S4 — Global search omnibox** | Topbar control extending `POST /api/v1/owners/search` (PII-in-body, `view_owner_pii`-gated national_id branch). Bidi-strip dropdown `aria-label`s; ephemeral results; no `?q=` PII param. | `owners.controller.ts:72` (reuse); new topbar omnibox | FE(+reuse BE) | **Same wave as the sidebar collapse (D.4).** |
| **C13 — Auth/onboarding re-skin** | Token re-skin of the first-touch cluster: `login`·`signup`·`forgot`·`reset`·`accept-invite`·`tenant/login`·`provider/auth login`. Verify per page the token re-skin reaches it; keep `method="post"` + the GET-fallback guard green. | `app/login`, `signup`, `forgot-password`, `reset-password`, `accept-invite`, `(tenant)/tenant/login` | FE | B1(coverage) first-touch surface. No auth-path logic change. |

---

## WAVE 2 — Backend-gated surfaces (run B1 in parallel with Wave-1 FE)

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **B1 — Pulse endpoint (row schema PINNED)** | `GET /api/v1/org/signature-pulse` (NO migration). Returns `{ buckets:{active,pastThreshold,inWork,stuck}, attention: ProjectPulseRow[] }`. **PIN the row contract:** `ProjectPulseRow` carries `lastSignatureAt`, `signedThisWeek`, `stalledDays`, `nextExpiryAt` — **define the join** (derive from `signature_requests.{signedAt,expiresAt,status,createdAt}` via `documents.project_id`; `signedThisWeek`=COUNT signedAt within 7d; `stalledDays`=now−MAX(signedAt); `nextExpiryAt`=MIN(expiresAt WHERE status='pending')). Reuse the `orgStats` multi-subquery + **agent-scope CTE** (`projects.service.ts:537-581`). **Reads through the PERF cache (Wave 0).** | new `org/signature-pulse` route + service; `shared-types` ProjectPulseRow; `gen-api-docs` entry | BE | Stub `**/api/v1/org/signature-pulse` in affected Playwright specs. Closes A5·A6·GAP-2. |
| **B4 — Holdout-name PII read** | **Concrete spec:** `GET /api/v1/projects/:id/signature-progress/apartments/:apartmentId/holdouts` → `{data:{holdouts:[{ownerId, name (NameDisplay-wrapped), apartmentNumber}]}}`. **Gated `view_owner_pii`**, audited (reveal audit row like `owners/:id/reveal-pii`), no national_id/phone in the response. `signatureProgressApartments` (`:456-526`) stays counts-only. | new route on `projects.controller.ts`; `projects.service.ts`; audit | BE | **A4 — the M2 chase "מי תקוע → tap → name" flow depends on this; specify before M2.** |
| **E2.1 — Home mission-control** | Replace the KPI grid + **delete the calendar stub** (`manager-home.tsx:115-139`); greeting + one pulse sentence + ~5 ranked `ActionCard`s; converge `AgentHome` onto the same `ActionCard`. **Migrate ManagerHome onto Pattern A** (RSC prefetch + Zod parse + TanStack — D.3). **Route Viewer to a read-only mission-control** (today `(dashboard)/page.tsx:33-37` sends Viewer → ManagerHome → `/org/stats` it can't read → "—"). **Design the empty-org/first-run state distinctly.** **Clean AgentHome's ~15 inline `var(--)` leaks BEFORE promoting its shape.** | `manager-home.tsx`, `agent-home.tsx`, `(dashboard)/page.tsx` | FE | Without B1, ship structure on derivable distance-signals + omit momentum. Closes B11·C-a. **C-g:** retire-or-repoint `/org/stats` (KPI grid deleted). |
| **E2.2-S3 — Board-first content** | Lift the board out of tab-4 into the default surface; wire real `ThresholdProgress` (`role=progressbar`+`aria-valuetext`, success-flip, basis label); promote "מי תקוע" to a named per-apartment list. Board never returns `null` (C2). | board components; `ThresholdProgress` hero | FE | Holdout *name* via B4; until B4 ships, apartment-grained ("דירה 7 · partial"). |
| **M2 — The one chase loop** | `resendSignatureRequest` wrapper (`postIdempotent`) over `POST /signature-requests/:id/resend` (`:142`, audited, 409-guarded) + `useRemindSignatureRequest` (optimistic; `prev` snapshot IS the undo) + ONE shared `<RemindHoldoutButton>` across home card / project "מי תקוע" / owner row. **Design the calm `recipient_not_associated` (409) envelope.** Treat server `expiresAt` as authoritative. | `lib/api/signature-requests.ts`; new `<RemindHoldoutButton>` | FE | **No future-nudge copy until B3 (A.2).** Closes B6. |
| **E2-list — Projects-list full-power** | `ProjectRow` enrichment (real counts), filter-by-status, **sort-by-distance now** (zero BE), URL-state, surface גוש/חלקה. Sort-by-momentum / expiring-soonest wire to B1's `lastSignatureAt`/`nextExpiryAt`. **List-level triage** (sort by expiring-soonest / stalled-longest). | `projects-list.client.tsx`; `project.vm.ts` | FE | Sort-by-momentum gates on B1. Label "סינון בעמוד הזה" until server search. Closes C6. (The *action* half of triage = C17, Wave 4.) |

---

## WAVE 3 — The "movie" + honest autonomy (gated on backend + owner)

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **M3 — Wow 1+2** | "כמעט שם" finish-line phrase + threshold-bar fill + on-screen "crossed the line" celebration (client-cache edge-diff of `metThreshold`). Calm/dignified, never confetti. | home + board components | FE | **Celebration inherits the basis-correctness gate (A.1 / B0)** — must not celebrate a legally-wrong crossing. On-screen edge only; the server "threshold reached" notification is the richer follow-up (B3). Reconcile count-up vs LCP (G-MOTION-PERF) first. |
| **B3 — Autonomy worker (RE-SCOPED: consumer + kinds, NOT a scheduler)** ⭐CRITICAL 🔒owner(infra) | **The scheduler ALREADY EXISTS** (`apps/worker/src/main.ts` runs 3 live sweeps — reaper hourly, audit-retention daily, signature-expiry hourly). **Scope = add ONE pg-boss cron consumer + 3 notification kinds + FE deep-links** (NOT "build a scheduler"): (i) the new consumer reads pending/expiring/stalled state on a cadence; (ii) emit the **3 NEW notification kinds** `expiring`/`stalled`/`threshold_reached` (confirmed absent — `shared-types/src/notification.ts` has exactly 8 kinds, none of these; `notification-links.ts:16-26` has no link target for them) + their **FE deep-link targets**; (iii) post-B2, drive auto-reminders. Spec the idempotency/locking model for a recurring `withTenant`/`withProvider` consumer (concurrency-1, the proven pattern). The expiry sweep itself (`packages/db/src/helpers/signature-expiry-sweep.ts`) emits ZERO notifications today — this slice adds the emission ON TOP. | new consumer in `apps/worker`; `notification.ts` kinds; `notification-links.ts`; producer | BE | **Unlocks the "it'll keep nudging" copy — and ONLY then (A.2).** Emits the threshold-reached notification the BE doesn't emit today (C11 seed). Closes **N3**·C-i. |
| **M5 — Campaign narration + preview + failed-surface** 🔒owner(none — eng) | Wrap the campaign send (`POST /projects/:id/signature-campaign`) in the ONE justified `ConfirmDialog` ("נשלח ל-N בעלים שטרם חתמו"); migrate its success line to M0. **+ SURFACE `failed` (N7):** the toast today shows `{created, skipped}` only (`signature-campaign-action.tsx`); the service computes per-owner `created`/`skipped_existing`/`failed`+reason (`signature-requests.service.ts:482-534`) — surface the **`failed` count + a drill-down** (cheap; data already on the wire). **+ NEW PREVIEW ENDPOINT (N8):** `POST /projects/:id/signature-campaign/preview` (or `?dryRun=1`) returning who-gets-this / who's-excluded / who-has-no-phone BEFORE fan-out; render it in the confirm. | `signature-campaign` UI; `ConfirmDialog`; new `signature-campaign.controller.ts` preview route; `gen-api-docs` entry | FE+BE | The only routine confirm that survives "undo over confirm". **C-k:** re-test the promoted control does NOT render for an agent with `manage_signatures` OFF. Closes **N7**·**N8**·G4. |
| **B2 — The "why" layer + withdrawn lifecycle** 🔒Gate-6(migration) | `ALTER TABLE signature_requests ADD COLUMN decline_reason text` + widen the status CHECK to add `'declined'` (mirror migration 0063's `'expired'`) + a manager "סמן כמתנגד" action; then unhide "X בעלים מתנגדים". **+ N13:** add a post-signature **`withdrawn`** lifecycle alongside `declined` (an auditable middle state between "nothing happens" and full GDPR erasure) — **owner/legal call on whether withdrawal is in MVP scope.** Hand-author `.sql` + `_journal.json`. **Budget the CHECK-widen ripple:** STATUS_LABELS in `adapters/signature-request.ts`, the `statusColor→intent` map, contractor-portal status surface, **every raw-SQL test INSERT** of `signature_requests`. | migration; `signature-requests.service.ts`; status maps; raw seeders | BE | Gate-6 schema. Until merged, "N מתנגדים" stays omitted (A.2). Closes B3-ripple·**N13**(if scoped). |

---

## WAVE 4 — Completeness + operator control (the long tail, sequenced)

> Ordered by persona/ops impact. **C1 is P0-class; C12b (recovery subset) + C16 (DSAR/RTBF) are
> GO-LIVE BLOCKERS** despite landing in the long tail — see §F.

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **C1 — Committee print-of-record** 🔒owner(PDF-vs-print) | The product's raison d'être: the וועדה/lawyer artifact carrying the **basis-labeled** tally. **Decide NOW:** print stylesheet (FE-only) vs a server-rendered audited immutable PDF endpoint (precedent: `signature-requests/:id/signed-document:112`). MUST carry the basis label (A.1) + a PII-egress cue. If server-PDF, it's a net-new BE slice. | new print stylesheet OR new `projects/:id/consent-record` PDF route | FE or BE | **P0-class.** A printed legal claim with no denominator is the most dangerous fabrication the product could emit. |
| **C12b — Provider operator console (recovery half)** ⭐CRITICAL 🔒owner(scope) **[GO-LIVE BLOCKER: MFA-reset + unlock + resend-invite subset]** | Fold in `PROVIDER-ADMIN-AUDIT.md` P0: the missing account-recovery toolkit. **MFA-reset + unlock + resend-invite are a GO-LIVE BLOCKER** (the first weekly MFA lockout otherwise needs a developer with raw DB access — `provider-tenant-users.controller.ts:59` is read-only today). The fuller set (deactivate, cross-tenant person search, impersonate) + **N14's job retry/drain affordance** can be post-MVP. Net-new BE + UI at every layer. | new `provider/*` controllers + UI; system-health drain/retry | BE+FE | **N5 — recovery subset PROMOTED to go-live blocker;** the rest owner-scoped. Closes G2(provider)·**N5**·**N14**(drain). |
| **C16 — Headless-route surfacing** 🔒owner(DSAR scope) **[GO-LIVE BLOCKER: DSAR + RTBF]** | NEW slice — minimal admin UI for the 15 live API routes with no screen. **PRIORITIZE the legally-mandatory pair (GO-LIVE BLOCKER):** GDPR **DSAR** `GET /owners/:id/data-export` + **RTBF** `POST /owners/:id/erase` (`owners.controller.ts:128,139` — irreversible, needs a confirm design) — a regulator/owner request must have a UI path. Then **member-overrides** PUT/DELETE (`member-overrides.controller.ts:47,57`). Discovery-records → C10; tasks/:id/assignees → tasks slice. | new admin surfaces; reuse `owners`/`member-overrides`/`tasks` controllers | FE(+confirm design) | **N6 — DSAR/RTBF is a compliance liability with no surface;** PROMOTED to go-live blocker. Closes **N6**·G1(API). |
| **C5 — Project-creation wizard + persist-or-drop** | Re-skin the 1468-line `projects/new/page.tsx` under "propose-don't-ask / smart defaults / one primary action per step". **+ N16 (must close before prod):** the wizard collects `unitType`/`areaSqm`, shows them in review, then **drops them on the wire** (`:273` Gate-6 TODO) — either **persist** (schema/Gate-6 migration) or **stop collecting**. | `projects/new/page.tsx` (+ optional schema) | FE(+small BE) | P1. Sets or destroys the emotional tone. Closes **N16**. |
| **C8 — Import flow re-skin + SSE reconcile** | Re-skin the live-SSE import flow (`use-import-progress.ts`, 11 EventSource/aria-live refs); its preview/confirm pause is the best "approve-don't-construct" precedent — M1/G6 must reconcile. Sweep raw `bg-amber-*`/`bg-blue-*`. **+ N17:** note the SSE 30-stream/pod cap (`imports.controller.ts:291 MAX_ACTIVE_STREAMS=30`) → **LISTEN/NOTIFY is the real fix, post-MVP** unless concurrent-import volume is expected at launch. | `imports/*`, `use-import-progress.ts` | FE | P1. C-b (national_id-mandatory rows) audited here, no shell-owner concept. Notes **N17**. |
| **C7 — Contractor share view** | Re-skin the יזם's primary external deliverable (`(contractor)/contractor/share/page.tsx:102,118,126,152`): kill `StatusBadge` + inline `var(--navy-*)` leaks; **restore the dropped BE lifecycle status** (today one opaque `invalidLink`); calm/token rubric. Reconcile `external_read` system role vs the bespoke `contractor_access_token` cookie path (G9). | `contractor/share/page.tsx`; `contractor-read.controller.ts` | FE | P1. Closes B8·G3·G9. |
| **C14 — Tenant portal + OTP** | Re-skin the `(tenant)/portal` (770 lines: leaks at `:165,202,277,332,421,549`) + `tenant/login` OTP first-touch. Own-PII masked display (D.47) untouched; the email self-edit form keeps `method="post"`. **P1.2 (SECURITY):** push `isValidIsraeliPhone` into `OtpRequest/Verify` schemas at the boundary. **Note:** the portal consent % is fixed in B0 (N4), not here. | `portal/page.tsx`, `tenant/login`, `otp` schemas | FE(+small BE) | P1. Closes B7·G4. |
| **C15 — Messages topbar cluster** | Optimistic send + toast + the panel's data source (the 6 `messaging.controller.ts:34-73` routes) + `/messages?c=` deep-link survival after the nav demotion. | new topbar panel; `messaging` routes; `notification-links.ts:26` | FE | P1. Closes B9·G3(msg)·G8. |
| **C12 — Provider-tier visual re-skin** | Re-skin all 8 wired provider pages (`provider/page.tsx`, `tenants`, `tenants/[id]`, `tenants/[id]/users`, `onboard`, `audit`, `audit/self`, `system-health`) + `PCSidebar` (`pc-sidebar.tsx:99-121`). Kill the `provider/system-health` hardcoded `bg-emerald/amber/red`. The 7 padlocked stubs stay honest placeholders. **P1.3:** provider `ParseUUIDPipe`→Zod. | `provider/**`, `pc-sidebar.tsx` | FE | P1. Closes A8·G1(visual). |
| **C17 — List-level control: bulk + saved views + triage** | NEW slice — the *action* half of triage (E2-list is the *view* half). **Bulk verbs:** bulk archive / status / resend across selected projects (net-new BE bulk endpoints on `projects.controller.ts`, which is single-`:id` only today). **Saved views** (persist the URL-state filters from E2-list). **Cross-project "expiring this week"** triage feeding off B1's pulse aggregation. | new bulk routes on `projects.controller.ts`; `projects-list.client.tsx`; saved-view persistence; `gen-api-docs` entries | BE+FE | P1. **N10 — calm-minimal-actions inverts into per-row drudgery at 200 projects without it.** Depends on B1 (aggregation) + E2-list (view). |
| **N11 — Tabu honesty gate** 🔒owner(decision) | The extract→review→confirm apparatus runs on `StubExtractionProvider` (`tabu/extraction-provider.factory.ts:36`, deterministic fake). **Make it HONEST:** ship **labeled manual-entry** as the path, OR build the real `IExtractionProvider` engine. Do **NOT** ship "extraction" UI over the stub in prod. | `extraction-provider.factory.ts`; tabu review UI labeling | BE(+UI label) | **N11 — honesty gate. Owner decides manual-entry-label vs build-the-engine.** (Roadmap `05:168` had it out-of-scope; the audit makes it an explicit prod gate.) |
| **C10 — Discovery/field-work FE** 🔒owner(scope) | `discovery_records` (migration 0066) has NO FE — half the "find the owner" workflow is BE-only (`discovery.controller.ts:37-57`). The board's SHELL state + the interim "why" substitute are unbuildable until a data-entry surface exists. Correct the dead-code model: renter-exclusion is a no-op (`RelationshipSchema=z.enum(['owner'])`); occupant/renter lives here. | `apartments/[id]/discovery`; `discovery.controller.ts` | FE | **P2, owner scope.** Closes C-b(discovery)·C-e·(part of N6). |
| **C11 — Populated calendar + notifications-as-momentum** 🔒owner(scope) | The *populated* calendar (`tasks.due_at` real; a `CalendarService` ICS generator exists but **no `GET /calendar` feed** — net-new BE if pulled in); notifications-as-momentum feed (B3 emits threshold-reached); multi-user concurrency (surface the resend 409 calmly as "כבר נשלח על ידי [שם]"). | new `GET /calendar` (if scoped); `tasks.due_at`; notifications | BE+FE | **P2, owner scope.** Closes C-h. |
| **M6 — StepUpDialog a11y retrofit** | Add the ESC/focus-trap/`aria-describedby` `StepUpDialog` lacks (which `ConfirmDialog` has). **Reconcile owner-PII reveal:** plain button today, not StepUp — decide whether owner reveal gets the same gate as documents (C-f). | `StepUpDialog`; owner reveal-PII surface | FE | P2. Closes C-f. |
| **C-c — Milestone overlay** | Decide the `signatureMilestones` (staged targets, editable via `update()`) overlay on the `ThresholdProgress` hero. | `ThresholdProgress`; `signatureMilestones` | FE | P2. One decision line. |
| **C-d — Member-permission override surface** | Name the override engine (`member-overrides.controller.ts`) in the Admin-group / Access-tab slice so a redesigned Access tab cannot desync from the override grants. (Overlaps C16's member-overrides surfacing — reconcile.) | members/overrides Admin panel | FE | P2. Consistency. |
| **C-l — Correct stale inventory numbers** | Fix "55 page.tsx / ~64 routes / 16 PCSidebar" → real **48 page.tsx / ~158 routes / 14 PCSidebar** wherever quoted. | the v2 plan docs (doc-only) | — | P2. Credibility only. |

**SECURITY P1/P2 residuals folded into their natural slices:** P1.1 `.strict()` on the ~13
`List*Query` schemas + guard → **S0-SEC follow-up** (Wave 0 tail). P1.2 OTP phone refine → **C14**.
P1.3 provider `ParseUUIDPipe`→Zod → **C12**. P1.4 org-login-failure audit event → **S0-SEC tail**.
P1.5 `--prod` dep-audit job · P1.6 method-level auth ratchet · P2.1 array `.max()` caps · P2.2
per-route `bodyLimit` · P2.3 sign `:token` `.max()` · P2.4 doc-scan inline→worker → **eng-hardening
mini-wave alongside Wave 4** (pure-engineering, no design dependency).

---

## C. The 4 CRITICAL items, front-loaded (the certainty gate)

The audit's four CRITICAL defects, in build order, with their dependency rationale:

| # | Slice | Wave | Why it is front-loaded |
|---|---|---|---|
| **1** | **S0-SEC** (global validation pipe + CI guard) | **Wave 0, FIRST** | N12 — must land before B0/B1/B4/B5 so the 4 new BE surfaces are validated *by construction*, not convention. The single hard ordering gate. |
| **2** | **B5** (status state-machine **+ optimistic-concurrency**) | **Wave 1** | N1+N2 — the #1 engineering-below-bar fix. `approved` is a legal state reachable any→any (`:773`); the UPDATE has no version predicate (`:803`) so two managers silently clobber. Both halves in ONE slice, before any board-first 'approve'. |
| **3** | **B0** (share-weighted consent **+ portal denominator + ConsentCalcService**) | **Wave 1** (gated on PERF) | N4 — the load-bearing legal boolean is binary by-heads (`:419-421`); the portal reads 100% at 10/35. The most dangerous OUTPUT. Gated behind the Wave-0 PERF cache + seeded-50-project gate (N9). |
| **4** | **B3** (RE-SCOPED: 1 cron consumer + 3 notification kinds + FE deep-links) | **Wave 3** | N3 — the clock cleans up but never chases. The scheduler ALREADY exists (3 live sweeps); this is a small add-a-consumer slice, not "build a scheduler". Unblocks the autonomy copy. |

**Supporting front-loaded gate:** **PERF** (Wave 0) — the cache + seeded perf test that B0 must pass.

---

## D. Coverage confirmation — every design gap (38) + every production gap (17) has a home

**v3 design gaps (38 = 9 P0 · 12 P1 · 12 P2 from `00-COVERAGE-MATRIX` + the named C-slices):**
A1·A2→**B0** · A3→**B5** · A4→**B4** · A5·A6→**B1** · A7→M0b (PR #413) · A8·A9→**E2.0-GUARD**+**C12** ·
B1→**C13** · B2→**M0+G6** · B3→**B2** ripple · B4→**C1** · B5→**B0** · B6→**M2** · B7→**C14** · B8→**C7** ·
B9→**C15** · B10→**S0-SEC** · B11→**E2.1** · B12→**P-TZ-1** · C-a→**E2.1** · C-b→**C8/C10** · C-c→**C-c** ·
C-d→**C-d** · C-e→**C10** · C-f→**M6** · C-g→**E2.1** · C-h→**C11** · C-i→**B3** · C-j→**Wave-0 doctrine**+**C2** ·
C-k→**M5** · C-l→**C-l**.

**v4 production gaps (17 = N1–N17):**
N1→**B5(ii)** · N2→**B5(i)** · N3→**B3 (re-scoped)** · N4→**B0 (+portal)** · N5→**C12b (recovery subset = blocker)** ·
N6→**C16 (DSAR/RTBF = blocker)** · N7→**M5 (failed-surface)** · N8→**M5 (preview endpoint)** · N9→**PERF + B0(ConsentCalcService)** ·
N10→**C17 (+E2-list view half)** · N11→**N11 (tabu honesty gate)** · N12→**S0-SEC** · N13→**B2 (withdrawn)** ·
N14→**C12b (drain) + ops checklist** · N15→**Wave-0 (CAMPAIGN_SEND_ENABLED)** · N16→**C5 (persist-or-drop)** · N17→**C8 (LISTEN/NOTIFY note)**.

**✅ All 38 design gaps + all 17 production gaps now have a concrete, sequenced home.**

---

## E. The full wave/slice list (dependency-ordered)

**Wave 0 — Foundation + security/perf gate (9 slices):** S0-SEC ⭐ · PERF ⭐ · E2.0 · E2.0-GUARD ·
E2.0b · M0+G6 · M1 · P-TZ-1 · C2.
**Wave 1 — Structural + consent + integrity (6 slices):** B0 ⭐ · B5 ⭐ · E2.2-S1 · E2-IA-S2 · S4 · C13.
**Wave 2 — Backend-gated surfaces (6 slices):** B1 · B4 · E2.1 · E2.2-S3 · M2 · E2-list.
**Wave 3 — Movie + autonomy (4 slices):** M3 · B3 ⭐ · M5 · B2.
**Wave 4 — Completeness + operator control (16 slices):** C1 · C12b ⭐ · C16 · C5 · C8 · C7 · C14 ·
C15 · C12 · C17 · N11 · C10 · C11 · M6 · C-c · C-d · C-l.
*(Plus M0b already shipped as PR #413, not re-counted, and the eng-hardening security mini-wave
alongside Wave 4.)*

**TOTAL: 41 build slices** (9 + 6 + 6 + 4 + 16), of which **4 are CRITICAL** (S0-SEC, B5, B0, B3)
and PERF is the supporting critical gate.

---

## F. GO-LIVE BLOCKERS vs POST-MVP

### 🚧 GO-LIVE BLOCKERS (must ship before the first paying customer)
1. **S0-SEC** — global validation pipe + CI guard (every new BE surface validated by construction).
2. **B5** — status state-machine **+ optimistic-concurrency** (no silent legal/business-state corruption).
3. **B0** — share-weighted consent + portal denominator (the legal number must be correct, behind the A.1 label).
4. **PERF** — cache + seeded-50-project gate (B0's heavier CTE must be proven sub-second).
5. **C12b (subset)** — MFA-reset + unlock + resend-invite (first weekly lockout otherwise needs a dev with DB access). 🔒owner
6. **C16 (subset)** — GDPR DSAR (`data-export`) + RTBF (`erase`) UI (compliance liability with no surface). 🔒owner
7. **C1** — committee print-of-record carrying the basis label (the product's raison d'être; a printed unlabeled % is the worst fabrication). 🔒owner(PDF-vs-print)
8. **N11** — tabu honesty: labeled manual-entry OR a real parser (never ship "extraction" over the stub). 🔒owner
9. **N16** — new-project wizard: persist or stop collecting `unitType`/`areaSqm` (no silent data loss). *(inside C5)*
10. **Ops** — `FILE_SCAN_CLAMAV_HOST` + EICAR smoke · PII keys staging/prod · `DOC_ENCRYPTION_KEY` staging/prod · `ALERT_WEBHOOK_URL` provisioned + boot assertion (N14, alerting fails-open today) · P0.4 magic-byte (in flight). 🔒owner-deploy
11. **N15** — `CAMPAIGN_SEND_ENABLED` env kill-switch (1-line; surgical insurance below org-suspend). *(Wave 0, cheap)*

### ⏭ POST-MVP (sequenced-out, not dropped)
- **B3 autonomy worker** is strongly desired but the honest one-tap chase (M2) ships first; B3 unlocks
  the "system keeps nudging" copy. *(If the owner wants autonomy at launch, B3 is a blocker — owner call.)*
- **C12b fuller set** (deactivate, cross-tenant person search, impersonate, job retry/drain UI). 🔒owner-scope
- **C17 bulk-ops + saved views** — needed at ~200 projects, not at first customer. 🔒owner-scope (could be a blocker if launch volume is high)
- **C10 discovery FE · C11 populated calendar (`GET /calendar`)** — owner-scoped E2-vs-post-MVP. 🔒
- **N13 withdrawn lifecycle** — owner/legal call on MVP scope.
- **N17 LISTEN/NOTIFY** for SSE import-progress (30-stream/pod cap) — only if concurrent-import volume is expected at launch.
- **The project-tab merger**, **forecast**, **per-owner deal terms / estate-POA / post-`approved` relocation tracking**.
- **Eng-hardening mini-wave** (P1.5/P1.6/P2.1–P2.4) — pure-engineering, no design dependency.

---

## G. Owner / external-gated slices (the 🔒 go/no-go list)

| Slice | Gate | The decision the owner/lawyer must make |
|---|---|---|
| **B0** | 🔒 LEGAL — OD-1/OD-3 | Exact statutory % (66 vs 67, pre-2023 80% grandfathering) + partial-share counting + SHELL-owner denominator. **Ships behind the interim basis-label; build is NOT blocked.** |
| **B3** | 🔒 owner — infra | Approve the new recurring worker consumer (autonomy copy stays off until then). Blocker only if autonomy is a launch requirement. |
| **B2** | 🔒 Gate-6 — migration | Approve `decline_reason` + `'declined'` (+ optional `withdrawn`, N13) schema migration. |
| **C1** | 🔒 owner — artifact | Print stylesheet vs server-rendered audited PDF for the committee record. **Go-live blocker.** |
| **C12b** | 🔒 owner — scope | Confirm the MFA-reset/unlock/resend subset as a go-live blocker; the fuller recovery set as post-MVP. |
| **C16** | 🔒 owner — scope | Confirm DSAR/RTBF UI as a go-live blocker (compliance); rest of the headless routes sequenced after. |
| **N11** | 🔒 owner — decision | Labeled manual-entry now vs build the real נסח parser. **Go-live honesty gate.** |
| **C10 / C11** | 🔒 owner — scope | Discovery FE / populated calendar (`GET /calendar`) in E2 scope or post-MVP. |
| **Wave-0 doctrine** | 🔒 owner — stance | OD-5 (`en` a real locale?), no-session-countdown UX, PII-egress cue, G-MOTION-PERF (count-up vs LCP). |
| **Ops** | 🔒 owner — deploy | ClamAV host + EICAR · PII keys staging/prod · DOC key staging/prod · `ALERT_WEBHOOK_URL` + boot assertion. |

---

## H. Verdict

`ready-to-build`. The v3 spine is intact; all 38 design gaps remain homed; the 17 v4 production gaps
collapse to **~7 actual units of work** (B5-double, B0-wave, B3-rescope, C12b/C16 operator cluster,
M5-widen, C17, PERF), of which **4 are CRITICAL** and all are bounded and unblocked. The certainty
gate is the four front-loaded CRITICAL slices (S0-SEC → B5 → B0 → B3) plus the PERF gate. Close those,
surface the failures the backend already computes (N7, nearly free), give the manager operator-recovery
(C12b) + the DSAR/RTBF surface (C16) + list-level control (C17), prove it in real Chrome per role — and
this is a production-grade, genuinely autonomous, genuinely controllable system. The surprise risk is
near zero: the only genuinely open questions are the **external/legal** ones, each shipping behind an
interim-safe rule or an explicit owner gate rather than a mid-build discovery.
