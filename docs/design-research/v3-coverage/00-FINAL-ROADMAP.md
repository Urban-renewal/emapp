# 00 — FINAL E2 IMPLEMENTATION ROADMAP (gap-closed, dependency-ordered)

> **Status:** DEFINITIVE go/no-go build artifact. Author: Design Lead synthesis seat,
> 2026-06-18. READ-ONLY planning doc — no app code changed by this document.
>
> **What this is.** The single, dependency-ordered, gap-closed roadmap that folds
> **every** gap from the v3 coverage audit (`00-COVERAGE-MATRIX.md` — 33 gaps: 9 P0,
> 12 P1, 12 P2) into `MASTER-PLAN-V2`'s wave structure, so the owner can build the
> whole E2 redesign **end-to-end in one pass with nothing discovered mid-build.**
>
> **Inputs reconciled:** `v2/00-MASTER-PLAN-V2.md` + the 8 expert docs · `v2/DECISIONS-LOCKED.md`
> (D.1–D.5) · `v3-coverage/00-COVERAGE-MATRIX.md` + the 6 dimension docs · `docs/SECURITY-POSTURE.md`
> (P0/P1/P2 program) · `docs/DESIGN-NORTH-STAR.md` (doctrine) · `docs/perf-research/PROVIDER-ADMIN-AUDIT.md`.
>
> **How to read this.** Waves run top-to-bottom; slices inside a wave can parallelize
> unless a dependency is noted. Every slice line carries: **name · what · the real
> files/endpoints it touches · BE-or-FE · its gate**. Owner/external-gated slices are
> flagged 🔒. The two binding rules (§A) are non-negotiable on every FE slice.

---

## A. The binding rules (carried verbatim from MASTER-PLAN-V2 — apply to every slice)

1. **The interim consent-basis-label rule (the single most important written rule).**
   Until the legal basis is confirmed (🔒 OD-1, §G), **no slice may render an unqualified
   consent % as a legal or threshold claim.** Every % carries its denominator label
   ("לפי שיעור הבעלות" vs "לפי ראשי דירות") and leads with the plain-Hebrew count
   sentence ("23 מתוך 40 דירות חתמו" — *not* a legal claim). Board-first, the print
   artifact (C1), and the threshold celebration (M3) all inherit this rule.

2. **The DO-NOT-FABRICATE register (binding on every FE slice).** Never render a signal
   the backend cannot honestly back:
   - "נזכיר שוב בעוד N ימים" / any future-nudge → ❌ FORBIDDEN until **B3** ships. Ship
     the honest past-tense "נשלחה תזכורת לאורי" only.
   - "N בעלים מתנגדים" / objection count or reason → ❌ FORBIDDEN until **B2**. Substitute
     "X דירות סומנו כסירוב" from `apartments.status` if a "why" is wanted.
   - "+N השבוע" / "אין תנועה N יום" / pulse buckets / forecast → ❌ omit until **B1**.
   - The holdout's NAME ("אורי") → ❌ until **B4**; show "דירה 7 · partial" meanwhile.
   - "שלחנו N תזכורות אתמול" / any "the system acted" claim → ❌ until **B3**.
   - Any unqualified consent % → ❌ always until OD-1 (rule 1).

**Universal DoD for EVERY slice below (no exceptions):**
`pnpm typecheck && pnpm lint && pnpm test` green — **including** the inline-color ratchet
(`app-no-new-inline-colors.spec.ts`), the **new class-name guard** (Wave 0), the
**new input-validation-coverage guard** (Wave 0, S0-SEC), `app-forms-no-get-fallback.spec.ts`,
and adapter/sidebar specs — **AND** a real-Chrome **4-axis** verify (Network / URL / Cookies /
Redirect, `docs/DOD-BROWSER-SMOKE.md`) **per affected role** — **AND** a North-Star check
(does this surface *reduce* actions, speak plain Hebrew, never fake a signal, stay
re-skinnable?). **Routes are never deleted** (re-composition, not re-routing). New
endpoints add a `gen-api-docs` ENDPOINTS entry (the api-docs-coverage guard fails CI
otherwise) and must land validated by the global pipe (S0-SEC).

---

## B. What changed vs MASTER-PLAN-V2 (the delta the owner is approving)

| # | Change | Why (audit gap) |
|---|---|---|
| 1 | **Consent calc (was `P0-FIX`, Wave 3) PROMOTED to Wave 1 as slice `B0`** and re-authored concretely (share-weighted CTE + per-building + partial-share + SHELL-denominator + `metThreshold` wire-contract + the ownerships-editor input surface). Un-marked "Blocked on OD-1" — OD-1 *un-blocks* it (D.1 locked share-weighted); only the statutory % stays legal-gated behind the interim label. | A1·A2·B5(ownerships) |
| 2 | **NEW slice `B5` — project-status-transition guard** (Wave 1, BE, no migration). | A3 |
| 3 | **B4 (holdout-name PII read) specified concretely** — route, request/response shape, `view_owner_pii` gate, audit (Wave 2). | A4 |
| 4 | **B1 pulse row schema PINNED** — `ProjectPulseRow` gains `lastSignatureAt`/`signedThisWeek`/`stalledDays`/`nextExpiryAt` + the join defined (Wave 2). | A5·A6 |
| 5 | **M0b (ConfirmDialog migration) marked COMPLETE** — landed as **PR #413** (today); the Wave-0 class-leak guard just ratchets over it. NOT re-authored here. | A7 |
| 6 | **Wave-0 leak-guard baseline RE-MEASURED across the FULL `components/**`+`app/**` tree** incl. the Provider-Admin subtree, every `*/new` + detail form, settings/members panels — before freezing. | A8·A9 |
| 7 | **NEW slice `C12` — Provider-tier visual re-skin** (Wave 4) + the half-built operator console (PROVIDER-ADMIN-AUDIT P0) folded in as `C12b`. | A8·G1·G2 |
| 8 | **NEW slices `C13` (auth/onboarding, Wave 1), `C14` (tenant portal + OTP, Wave 4), `C15` (messages topbar cluster, Wave 4)**; **`C7` (contractor share) given a real Wave-4 slot**. | B1·B7·B8·B9 |
| 9 | **NEW slice `S0-SEC` — global `APP_PIPE` + input-validation-coverage CI guard** (Wave 0), reconciling SECURITY-POSTURE P0.1/P0.2 (+ P0.3) so the 4 new BE surfaces land validated by construction. | B10 |
| 10 | **Every Tier-B/C gap absorbed into a named wave with an explicit scope line** — the "Wave 4 / slot by owner priority" bucket is deleted and actually sequenced. | all P1/P2 |

> **Net structural change:** the spine of MASTER-PLAN-V2 is unchanged (board-first IA,
> the chase loop, tokens+leak-guard, the 4 honest BE slices, the DO-NOT-FABRICATE
> register). The delta is **re-sequencing + concretizing already-made decisions** plus
> **six small new re-skin/coverage slices** and **one security foundation slice**.

---

## WAVE 0 — Foundation (zero-screen-redesigned; everything depends on it)

> Front-loaded: tokens, the fused live-region, the security pipe, the tz fix, DataState.
> No screen is "redesigned" yet — but every guard that polices later waves is frozen here.

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **E2.0 — Tokens** | Tier-2 semantic block + semantic Tailwind mappings + the two missing scales **`--space-1..12`** & **`--text-display..caption`** (Heebo 400/500/700 only) + fix the 3 shipping bugs: dead `bg-card` (×41 files), contradictory `--r-lg` (12 vs 8px), `borderRadius.lg→var(--r-lg)`. Brand fork → `--brand → --navy-900` (D.5, one-token edit). | `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts` | FE | Additive; existing ratchet + typecheck prove it; no screen changes. |
| **E2.0-GUARD — Class-name leak guard (re-measured baseline)** | Add a NEW static guard flagging `(bg\|text\|border\|ring)-(gray\|slate\|zinc\|emerald\|green\|amber\|yellow\|red\|rose\|blue\|…)-[0-9]` in `components/**`+`app/**`. **RE-MEASURE the baseline across the FULL tree FIRST** — incl. the **Provider-Admin subtree** (`provider/**`, `pc-sidebar.tsx`, `provider/system-health` hardcoded `bg-emerald/amber/red`), every `*/new` (esp. `projects/new` 1468 lines), every detail form, settings sub-configs, members/overrides panels, contractor share, tenant portal — then freeze at the TRUE count and ratchet DOWN each slice. | new `apps/web/src/*-no-default-palette-class.spec.ts`; baseline scan over full `app/**`+`components/**` | FE | **A8·A9 — must include provider + all forms or it ratchets from a false floor.** |
| **E2.0b — StatusPill + statusColor→intent** | Re-home `status-badge.tsx` + `Button.destructive` onto token `.badge-*`; rename `statusColor:'gray\|amber\|emerald\|red'` → intent `success\|warning\|danger\|info\|neutral` across `models/project.vm.ts:28` + the 6 adapters (`project.ts:48`, `apartment.ts:32`, `signature-request.ts:30`, `task.ts:34`, `import.ts:35`, `portal.ts`) + the 3 specs (`project.spec.ts:69`, `apartment.spec.ts:89,93`, `portal-progress.spec.ts:74`). | listed VM/adapters/specs, `status-badge.tsx` | FE | `adapters/*.spec.ts` guard the rename; re-skins every list/card at once. |
| **S0-SEC — Global validation pipe + coverage guard** 🔒eng | Global `APP_PIPE` (`GlobalZodValidationPipe`) + `@ZodBody`/`@ZodQuery` metadata + explicit `@RawBody`/`@NoValidation` markers for the 4 known exceptions (documents `:id/content` raw bytes; auth + provider-auth `refresh`/`logout` cookie-only). NEW CI guard `input-validation-coverage.spec.ts` (static scan of every `*.controller.ts`, modeled on `api-docs-coverage.spec.ts`). + Regression lock `CreateOwnerDto.safeParse({national_id:'123456789'})` fails (P0.3). | `apps/api/src/main.ts`, `app.module.ts`, every `*.controller.ts`, new spec | BE | **B10 — lands BEFORE B0/B1/B4/B5/B2 so all new endpoints are validated by construction, not convention.** SECURITY-POSTURE P0.1+P0.2+P0.3. |
| **M0+G6 — Unified announcement primitive** | ONE app-root `role="status" aria-live="polite"` (+`assertive`) live-region that is BOTH the `ActionToast` (auto-dismiss, pause-on-hover, undo, concurrent `settle`) AND the a11y G6 region. Migrate the bespoke non-dismissing inline "saved" lines — **enumerate ALL ~11 sites** (the 6 settings sub-configs + role-editor + member-capabilities/overrides panels), not "~4" (B2/coverage). Follow the `ConfirmDialog` a11y contract (ESC/trap/roles), NOT `StepUpDialog`. | new live-region primitive; settings/members feedback sites | FE | Tension-5 fusion (build once or double-SR-announce). Absorbs coverage **B2**. |
| **M1 — Motion tokens** | `--motion-duration-{fast,base,slow}` + `--motion-ease-*` + `prefers-reduced-motion` guard (zero durations under `reduce`). No looping animation except the existing skeleton pulse. | `globals.css` | FE | Owned here (not "jointly"). |
| **P-TZ-1 — Relative-time fix + ICU plurals** | `formatRelative` (used by 18 adapters) → pin "now" AND target to `Asia/Jerusalem` before diffing; unit test for a UTC instant near the IDT day boundary. **+ Add ICU-plural + native-Hebrew copy** for count sentences ("שתי חתימות"), not dev string concat (absorbs **B12**/X9). | `apps/web/src/lib/format.ts` + new test; i18n message catalogs | FE | Cross-cutting correctness; gates chase-loop honesty. |
| **C2 — `<DataState>` contract** | ONE wrapper: loading skeleton / calm error+retry / **403 access-denied muted, no retry** / guided empty. Wires the M0/G6 live-region. **Kill "silent null on error"** (`signature-progress-board.tsx:36` returns bare `null`). | new `DataState`; `signature-progress-board.tsx`; `ListSkeleton`/`ListPageShell` | FE | Resolves the UX-vs-FE "never silent" contradiction. Absorbs **C-j** offline-banner stub hook. |

**Wave-0 owner/external decisions to clear here:** 🔒 OD-5 (`en` is a real shipping
locale? ripples into copy scope) · 🔒 OD-6 brand fork (resolved by D.5, just confirm) ·
**doctrine lines** needing an explicit owner stance (C-j): "no session countdown" UX,
PII-egress cue, bidi-interpolation static guard, perf LCP-vs-M3 gate (G-MOTION-PERF).

---

## WAVE 1 — Structural redesign + consent correctness (zero/low-BE; the app starts to *feel* redesigned)

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **B0 — Share-weighted consent calc** 🔒OD-1(statutory %) | Re-author `signatureProgress` (`projects.service.ts:355–431`): replace the binary `apartmentsConsented/totalApartments` (`:419–421`) with a **share-weighted CTE** reading `ownerships.share_numerator/denominator` (migration 0065, DB-guaranteed sum=1). Add **per-building `GROUP BY`** (per-building option), **partial-share credit decision** (does a partly-signed apartment's signed-share count — OD-3), and the **SHELL-owner denominator effect** (a shell owner with no national_id in/excluded from the denominator). **Pin the wire-contract (A2):** keep `metThreshold` as THE boolean the FE reads (now share-basis); keep `consentedPct` (by-heads) on the wire as a *supporting* line (do NOT remove — home/board/list/M3 read it); add `consentedShare`/`metThresholdByShare` + `byBuilding[]`. **Migrate the 3 specs** asserting the binary (`projects.service.spec` consent cases) to the new share-basis + keep one by-heads assertion. **Includes the INPUT surface:** the ownerships editor `apartments/[id]/ownerships/page.tsx` (the share-num/den entry the headline depends on) gets re-skinned + validated. | `projects.service.ts` consent block; `ownerships` schema (read-only); `apartments/[id]/ownerships/page.tsx`; the consent specs; `shared-types/src/project.ts` SignatureProgress | BE+FE | **🔒 D.1 locked share-weighted — NOT blocked. The exact statutory % + partial-share rule = [LEGAL — owner/lawyer confirm]; ship behind the interim basis-label (rule A.1) until then.** Closes A1·A2·B5. |
| **B5 — Status-transition guard** | Replace the unguarded setter in `projects.service.ts:762` `update()` (today `patch.status = input.status`, any→any) with a **state machine**: allowed transitions over the D.18 enum (planning → gathering_signatures → approved → in_construction → completed; any → cancelled) + a **`metThreshold` precondition for `approved`** (cannot mark approved unless B0's share-basis `metThreshold` is true). Illegal transition → `{ error: { code:'invalid_status_transition' } }`. Add unit tests per edge. | `projects.service.ts` `update()`; new transition map; spec | BE | **A3 — lands BEFORE any board-first "approve / you can file" action wires to it.** No migration. |
| **E2.2-S1 — Board-first tabs** | Flip default `useState('tenants')→'signatures'`, re-order tabs (1 חתימות · 2 מבנה · 3 מסמכים · 4 פעילות · 5 גישה · overflow הגדרות), inline the empty-CTA targets. Board content already renders real wire data. | `project-detail.client.tsx:79`; tab components | FE | **Scope = tab DEFAULT + ORDER only** (the tab *merger* is deferred, §F). **Board % carries the basis label (A.1) from first render.** |
| **E2-IA-S2 — Sidebar 14→5 + Admin group** | Regroup `sidebar.tsx:113–145`: spine = Home · Projects · Owners (gated `owners.read`) · Imports · Tasks; collapse members/audit/settings → "ניהול/Admin" (gates verbatim); demote notes/contractors/messages/signature-requests/documents; drop the redundant notifications nav line (bell stays). **Keep ALL routes.** | `sidebar.tsx`; `(dashboard)/layout.tsx` | FE | Per-role smoke: Agent still scoped, Viewer no create CTAs, demoted routes still deep-link-reachable. **Ship S4 search no later than this slice** (no nav-or-search hole). |
| **S4 — Global search omnibox** | Topbar control extending `POST /api/v1/owners/search` (PII-in-body, `view_owner_pii`-gated national_id branch; GET for non-PII branches). Bidi-strip dropdown `aria-label`s; ephemeral results, no history; no `?q=` PII param. | `owners.controller.ts:72` (reuse); new topbar omnibox | FE(+reuse BE) | **Ships in the SAME wave as the sidebar collapse (D.4).** |
| **C13 — Auth/onboarding re-skin** | Token re-skin of the first-touch + team-onboarding cluster: `login`·`signup`·`forgot`·`reset`·`accept-invite`·`tenant/login`·`provider/auth login`. **Verify per page** that the token re-skin reaches it (some sit outside `[locale]/layout`); keep `method="post"` + the GET-fallback guard green. | `app/login`, `signup`, `forgot-password`, `reset-password`, `accept-invite`, `(tenant)/tenant/login` | FE | **B1(coverage) — first-touch surface; was unscheduled.** No auth-path logic change. |

---

## WAVE 2 — Backend-gated surfaces (run B1 in parallel with Wave 1's FE)

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **B1 — Pulse endpoint (row schema PINNED)** | `GET /api/v1/org/signature-pulse` (NO migration). Returns `{ buckets:{active,pastThreshold,inWork,stuck}, attention: ProjectPulseRow[] }`. **PIN the row contract (A5·A6):** `ProjectPulseRow` carries `lastSignatureAt`, `signedThisWeek`, `stalledDays`, `nextExpiryAt` per project — **define the join** (derive all from `signature_requests.{signedAt,expiresAt,status,createdAt}` joined via `documents.project_id`; `signedThisWeek` = COUNT signedAt within 7d; `stalledDays` = now − MAX(signedAt); `nextExpiryAt` = MIN(expiresAt WHERE status='pending')). Reuse the `orgStats` multi-subquery + **agent-scope CTE** (`projects.service.ts:537–581`) so an agent's pulse covers only assigned projects. | new `org/signature-pulse` route + service; `shared-types` ProjectPulseRow; `gen-api-docs` entry | BE | Stub `**/api/v1/org/signature-pulse` in affected Playwright specs. Closes A5·A6·GAP-2. |
| **B4 — Holdout-name PII read** | **Concrete spec:** `GET /api/v1/projects/:id/signature-progress/apartments/:apartmentId/holdouts` → `{ data: { holdouts: [{ ownerId, name (NameDisplay-wrapped), apartmentNumber }] } }`. **Gated `view_owner_pii`**, audited (write a reveal audit row like `owners/:id/reveal-pii`), no national_id/phone in the response. `signatureProgressApartments` (`:456–526`) stays counts-only; this is the net-new name read. | new route on `projects.controller.ts`; `projects.service.ts`; audit | BE | **A4 — the M2 chase "מי תקוע → tap → name" flow depends on this; specify before M2.** |
| **E2.1 — Home mission-control** | Replace the KPI grid + **delete the calendar stub** (`manager-home.tsx:115–139`); greeting + one pulse sentence + ~5 ranked `ActionCard`s; converge `AgentHome` onto the same `ActionCard`. **Migrate ManagerHome onto Pattern A** (RSC prefetch + Zod parse + TanStack — D.3). **Route Viewer to a read-only mission-control** (`(dashboard)/page.tsx:33–37` today sends Viewer → ManagerHome → `/org/stats` it can't read → "—"). **Design the empty-org/first-run state distinctly** ("ניצור את הפרויקט הראשון", NOT "הכול זז יפה"). **Clean AgentHome's ~15 inline `var(--)` leaks BEFORE promoting its shape** (Tension 7). | `manager-home.tsx`, `agent-home.tsx`, `(dashboard)/page.tsx` | FE | Without B1, ship structure on derivable distance-signals + **omit momentum**. Closes **B11**(viewer)·**C-a**(empty-org). **C-g:** retire-or-repoint `/org/stats` (one line — KPI grid deleted → endpoint dead-or-repointed). |
| **E2.2-S3 — Board-first content** | Lift the board out of tab-4 into the default surface; wire real `ThresholdProgress` (`role=progressbar`+`aria-valuetext`, success-flip on cross, basis label); promote "מי תקוע" to a named per-apartment list. Board never returns `null` (C2). | board components; `ThresholdProgress` hero | FE | Holdout *name* via B4; until B4 ships, apartment-grained ("דירה 7 · partial"). |
| **M2 — The one chase loop** | `resendSignatureRequest` wrapper (`postIdempotent`) over the existing `POST /signature-requests/:id/resend` (`:142`, audited, 409-guarded) + `useRemindSignatureRequest` (optimistic; `prev` snapshot IS the undo) + ONE shared `<RemindHoldoutButton>` across home card / project "מי תקוע" / owner row. **Design the calm `recipient_not_associated` (409) envelope** (sending to a globally-searched owner) — "כבר נשלח / לא משויך", not a bare error (**B6**). Treat server `expiresAt` as authoritative; optimistic flip distinguishes "sent" from "queued/failed offline". | `lib/api/signature-requests.ts`; new `<RemindHoldoutButton>`; optimistic precedents | FE | **No future-nudge copy until B3 (A.2).** Closes **B6**. |
| **E2-list — Projects-list full-power** | `ProjectRow` enrichment (real counts now), filter-by-status, **sort-by-distance now** (zero BE — counts already on rows), URL-state. Surface גוש/חלקה (on the VM, zero BE). **Sort-by-momentum / expiring-soonest** wire to B1's pinned `lastSignatureAt`/`nextExpiryAt`. **List-level triage** (sort by expiring-soonest / stalled-longest), not just an enriched row (**C6**). | `projects-list.client.tsx`; `project.vm.ts` | FE | Sort-by-momentum gates on B1 — omit until then. Label "סינון בעמוד הזה" until server search. Closes **C6**. |

---

## WAVE 3 — The "movie" + honest autonomy (gated on backend + owner)

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **M3 — Wow 1+2** | "כמעט שם" finish-line phrase + threshold-bar fill + on-screen "crossed the line" celebration (client-cache edge-diff of `metThreshold`). Calm/dignified, never confetti. | home + board components | FE | **Celebration inherits the basis-correctness gate (A.1 / B0)** — must not celebrate a legally-wrong crossing. On-screen edge only while watching; the server "threshold reached" notification is the richer follow-up (B3). |
| **B3 — Autonomy worker** 🔒owner(infra) | A single recurring Railway worker (NET-NEW infra; zero schedulers today): (i) sweep lapsed `pending`→`expired`, (ii) emit "expiring in N days" / "stalled" notifications via the existing producer, (iii) post-B2, drive auto-reminders. **Spec the NEW notification kinds** (`expiring`/`stalled`/`threshold_reached` — none exist in `notification-links.ts:16–26`) + their FE deep-link targets, + the idempotency/locking model for a recurring `withTenant`/`withProvider` worker (**C-i/GAP-6**). | new `apps/worker` scheduler; `notification-links.ts`; producer | BE | **Unlocks the "it'll keep nudging" copy — and ONLY then (A.2).** Also emits the threshold-reached notification the BE doesn't emit today (**C11** seed). |
| **M5 — Campaign narration** | Wrap the campaign send (`POST /projects/:id/signature-campaign`) in the ONE justified `ConfirmDialog` ("נשלח ל-N בעלים שטרם חתמו"); migrate its lingering success line to M0. | `signature-campaign` UI; `ConfirmDialog` (already merged, PR #413) | FE | The only routine confirm that survives "undo over confirm". **C-k:** re-test the promoted control does NOT render for an agent with `manage_signatures` OFF (`agent-effective-permissions.ts`). |
| **B2 — The "why" layer** 🔒Gate-6(migration) | `ALTER TABLE signature_requests ADD COLUMN decline_reason text` + widen the status CHECK to add `'declined'` (mirror migration 0063's `'expired'`) + a manager "סמן כמתנגד" action; then unhide "X בעלים מתנגדים". Hand-author `.sql` + `_journal.json`. **Budget the CHECK-widen ripple (B3-coverage/GAP-5):** STATUS_LABELS in `adapters/signature-request.ts`, the `statusColor→intent` map, contractor-portal status surface, **every raw-SQL test INSERT** of `signature_requests`. | migration; `signature-requests.service.ts`; status maps; raw seeders | BE | Gate-6 schema. Until merged, the "N מתנגדים" phrase stays omitted (A.2). |

---

## WAVE 4 — Completeness surfaces (the long tail, now SEQUENCED — no "slot by owner priority" bucket)

> Ordered by persona impact. **C1 is P0-class** despite landing after the core triad.

| Slice | What | Files / endpoints | BE/FE | Gate |
|---|---|---|---|---|
| **C1 — Committee print-of-record** 🔒owner(PDF-vs-print decision) | The product's raison d'être: the וועדה/lawyer artifact carrying the **basis-labeled** tally. **Decide NOW (B4-coverage/GAP-4):** print stylesheet (FE-only) vs a server-rendered audited immutable PDF endpoint (precedent: `signature-requests/:id/signed-document`, `:112`). The artifact MUST carry the basis label (A.1) + a PII-egress cue. If server-PDF, it's a net-new BE slice — decide before building. | new print stylesheet OR new `projects/:id/consent-record` PDF route | FE or BE | **Promoted to P0-class.** A printed legal claim with no denominator is the most dangerous fabrication the product could emit. |
| **C5 — Project-creation wizard** | Re-skin the 1468-line `projects/new/page.tsx` (the יזם's first deep interaction) under "propose-don't-ask / smart defaults / one primary action per step". Already in the E2.0-GUARD baseline. | `projects/new/page.tsx` | FE | P1. Sets or destroys the emotional tone. |
| **C8 — Import flow re-skin + SSE reconcile** | Re-skin the live-SSE import flow (`use-import-progress.ts`, 11 EventSource/aria-live refs); its preview/confirm pause is the best "approve-don't-construct" precedent — M1/G6 must reconcile (don't ship a second live-update idiom). Sweep its raw `bg-amber-*`/`bg-blue-*`. | `imports/*`, `use-import-progress.ts` | FE | P1. **C-b** (import write-rules: national_id-mandatory rows) audited here, no shell-owner concept. |
| **C7 — Contractor share view** | Re-skin the יזם's primary external deliverable (`(contractor)/contractor/share/page.tsx:102,118,126,152`): kill `StatusBadge` + inline `var(--navy-*)` leaks; restore the dropped BE lifecycle status (today one opaque `invalidLink`); calm/token rubric. **Reconcile** whether it consumes the `external_read` system role (`system-roles.ts:120–132`) or the bespoke `contractor_access_token` cookie path (**G9**). | `contractor/share/page.tsx`; `contractor-read.controller.ts` | FE | P1. Closes **B8·G3·G9**. |
| **C14 — Tenant portal + OTP** | Re-skin the `(tenant)/portal` (770 lines: `portal/page.tsx:165,202,277,332,421,549` leaks) + `tenant/login` OTP first-touch (least-technical user). Own-PII masked display (D.47) untouched; the email self-edit form keeps `method="post"`. **P1.2 (SECURITY):** push `isValidIsraeliPhone` into `OtpRequest/Verify` schemas at the boundary. | `portal/page.tsx`, `tenant/login`, `otp` schemas | FE(+small BE) | P1. Closes **B7·G4**; the portal `resendForOwner` clock-rotation is the M2 seam (already acknowledged). |
| **C15 — Messages topbar cluster** | Optimistic send + toast + the panel's data source (the 6 `messaging.controller.ts:34–73` routes) + `/messages?c=` deep-link survival after the nav demotion. In-flight owner epic — give it a design home, not a half-styled icon. | new topbar panel; `messaging` routes; `notification-links.ts:26` | FE | P1. Closes **B9·G3(msg)·G8**. |
| **C12 — Provider-tier visual re-skin** | Re-skin all 8 wired provider pages (`provider/page.tsx`, `tenants`, `tenants/[id]`, `tenants/[id]/users`, `onboard`, `audit`, `audit/self`, `system-health`) + `PCSidebar` (`pc-sidebar.tsx:99–121`). Kill the `provider/system-health` hardcoded `bg-emerald/amber/red` (already in the E2.0-GUARD baseline). The 7 padlocked stubs stay honest placeholders. | `provider/**`, `pc-sidebar.tsx` | FE | P1. Closes **A8·G1**. |
| **C12b — Provider operator-half (account recovery)** 🔒owner(scope) | Fold in `PROVIDER-ADMIN-AUDIT.md` P0: the missing account-recovery toolkit (reset/unlock a tenant user, reset MFA, resend invite, deactivate, cross-tenant person search) — **net-new BE + UI at every layer**. **Owner decides E2-scope vs post-MVP** (the audit's P0 list is large; it is the operator console's missing half). | new `provider/*` controllers + UI | BE+FE | P1–P2. Closes **G2**. Owner-gated scope call. |
| **C10 — Discovery/field-work FE** 🔒owner(scope) | `discovery_records` (migration 0066) has NO FE — half the "find the owner" workflow is BE-only (`discovery.controller.ts:37–57`). The board's SHELL state + the interim "why" substitute are unbuildable until a data-entry surface exists. **Owner decides E2-scope vs post-MVP.** Correct the dead-code mental model: renter-exclusion is a no-op (`RelationshipSchema=z.enum(['owner'])`); occupant/renter lives here now (**C-e**). | `apartments/[id]/discovery`; `discovery.controller.ts` | FE | P2, owner scope. Closes **C-b(discovery)·C-e**. |
| **C11 — Populated calendar + notifications-as-momentum** 🔒owner(scope) | The *populated* calendar (`tasks.due_at` real; a `CalendarService` ICS generator exists but **no `GET /calendar` feed** — net-new BE if pulled in, **C-h/GAP-8**); notifications-as-momentum feed (B3 emits the threshold-reached kind); multi-user concurrency (surface the resend 409 calmly to user B as "כבר נשלח על ידי [שם]"). | new `GET /calendar` (if scoped); `tasks.due_at`; notifications | BE+FE | P2, owner scope. Closes **C-h**. |
| **M6 — StepUpDialog a11y retrofit** | Add the ESC/focus-trap/`aria-describedby` `StepUpDialog` lacks (which `ConfirmDialog` has) — the modal a fearful user hits revealing a phone number. **Reconcile owner-PII reveal:** it's a plain button today, not StepUp — decide whether owner reveal gets the same gate as documents (**C-f**). | `StepUpDialog`; owner reveal-PII surface | FE | P2. Closes **C-f**. |
| **C-c — Milestone overlay** | Decide the `signatureMilestones` (staged targets, already modeled, editable via `update()`) overlay on the `ThresholdProgress` hero. | `ThresholdProgress`; `signatureMilestones` | FE | P2. One decision line in the hero. |
| **C-d — Member-permission override surface** | Name the override engine (`member-overrides.controller.ts`) in the Admin-group / Access-tab slice so a redesigned Access tab cannot desync from the override grants. | members/overrides Admin panel | FE | P2. Consistency. |
| **C-l — Correct the stale inventory numbers** | Fix the plan's "55 page.tsx / ~64 routes / 16 PCSidebar" → real **48 page.tsx / ~150 routes / 14 PCSidebar** wherever quoted, so the inventory is trustworthy. | the v2 plan docs (doc-only) | — | P2. Credibility only. |

**SECURITY P1/P2 residuals folded into their natural slices:** P1.1 `.strict()` on the
~13 `List*Query` schemas + guard → fold into **S0-SEC** follow-up (Wave 0 tail). P1.2 OTP
phone refine → **C14**. P1.3 provider `ParseUUIDPipe`→Zod → **C12**. P1.4 org-login-failure
audit event → **S0-SEC** tail. P1.5 `--prod` dep-audit job · P1.6 method-level auth ratchet
· P2.1 array `.max()` caps · P2.2 per-route `bodyLimit` · P2.3 sign `:token` `.max()` ·
P2.4 doc-scan inline→worker → schedule as an **eng-hardening mini-wave alongside Wave 4**
(pure-engineering, no design dependency). **Owner ops checklist (pre-go-live, blocking):**
provision `FILE_SCAN_CLAMAV_HOST` + EICAR smoke · PII keys (`PII_ENCRYPTION_KEY`/`PII_HASH_KEY`)
in staging+prod · `DOC_ENCRYPTION_KEY` in staging+prod · P0.4 magic-byte (in flight,
`fix/document-magic-byte-verification` — track to merge, don't duplicate).

---

## C. Owner / external-gated slices (the go/no-go decision list)

| Slice | Gate | The decision the owner/lawyer must make |
|---|---|---|
| **B0** | 🔒 LEGAL — OD-1/OD-3 | Exact statutory % (66 vs 67, pre-2023 80% grandfathering) + whether a partially-signed apartment's signed-share counts + SHELL-owner denominator. **Ships behind the interim basis-label until confirmed** (build is NOT blocked; only the legal label is). |
| **B3** | 🔒 owner — infra | Approve the net-new recurring Railway worker (the autonomy doctrine has no backend until this). |
| **B2** | 🔒 Gate-6 — migration | Approve the `decline_reason` + `'declined'` schema migration. |
| **C1** | 🔒 owner — artifact | Print stylesheet vs server-rendered audited PDF for the committee record. |
| **C12b** | 🔒 owner — scope | Is the Provider operator account-recovery half in E2 scope or post-MVP? |
| **C10** | 🔒 owner — scope | Is the discovery/field-work FE in E2 scope or post-MVP? |
| **C11** | 🔒 owner — scope | Is the populated calendar (needs a net-new `GET /calendar` feed) in E2 scope? |
| **Wave-0 doctrine** | 🔒 owner — stance | OD-5 (`en` a real locale?), no-session-countdown UX, PII-egress cue, G-MOTION-PERF (count-up vs LCP budget). |
| **Ops** | 🔒 owner — deploy | ClamAV host + EICAR smoke · PII keys staging/prod · DOC key staging/prod. |

---

## D. Coverage confirmation — every one of the 33 audit gaps has a concrete home

**TIER A (P0 ×9):** A1·A2→**B0** · A3→**B5** · A4→**B4** · A5·A6→**B1** (pinned row) ·
A7→**M0b complete (PR #413)** · A8·A9→**E2.0-GUARD** (full-tree baseline) + **C12**.
**TIER B (P1 ×12):** B1→**C13** · B2→**M0+G6** · B3→**B2** ripple checklist · B4→**C1** ·
B5→**B0** (ownerships) · B6→**M2** · B7→**C14** · B8→**C7** · B9→**C15** · B10→**S0-SEC** ·
B11→**E2.1** (Viewer) · B12→**P-TZ-1** (ICU plurals).
**TIER C (P2 ×12):** C-a→**E2.1** (empty-org) · C-b→**C8/C10** · C-c→**C-c** · C-d→**C-d** ·
C-e→**C10** · C-f→**M6** · C-g→**E2.1** (`/org/stats` fate) · C-h→**C11** · C-i→**B3** (kinds/locking) ·
C-j→**Wave-0 doctrine** + **C2** · C-k→**M5** (agent re-test) · C-l→**C-l** (inventory fix).

**All 33 gaps sequenced. No "slot by owner priority" bucket remains.**

---

## E. Verdict

`ready-to-build`. The spine of MASTER-PLAN-V2 is intact; the 9 P0 gaps are now concrete
slices in Waves 0–2 (mostly re-sequencing + concretizing already-locked decisions), the
12 P1 gaps each have a named Wave-1/2/4 home, and the 12 P2 gaps are sequenced into Wave 4
or folded into a foundation slice. The surprise risk is near zero: the only genuinely
open questions are the **external/legal** ones (B0 statutory %, the four owner-scope calls,
the deploy ops) — and each ships behind an interim-safe rule or an explicit owner gate
rather than a mid-build discovery.

---

## F. Explicitly deferred (sequenced-out, not dropped)

- The project-tab **merger** (docs+sig-requests → one surface; tasks+notes → Activity) —
  a separate slice after board-first lands (Tension 2 pare-back). E2.2-S1 is default+order ONLY.
- Saved views (S5) — URL-state filters first (E2-list), persistence later.
- Forecast — derivable but noisy; suppress at velocity≈0 / tiny N even after B1.
- Per-owner deal terms, estate/POA flags, lifecycle-after-`approved` (relocation tracking) —
  post-MVP real-workflow gaps.

## G. Genuinely uncertain (un-resolvable by the council — carry the verify gate forward)

- The legal consent basis + exact statutory % — domain/lawyer, NOT a code claim (🔒 OD-1).
- **Contrast + RTL are computed/static, not rendered** — `--text-muted` ~4.76:1 fails on
  tinted surfaces (use `--ink-600`); the wizard `ArrowLeft` RTL direction `[UNVERIFIED]`.
  Carry "verify in real Chrome + a Hebrew screen-reader pass" forward; do NOT treat computed
  ratios as a passed audit.
- Whether `en` is a real shipping locale (🔒 OD-5) — ripples into copy/domain/visual scope.
- G-MOTION-PERF — count-up on every home load vs the LCP budget (warm 200ms, Heebo 3 weights).
  Reconcile motion with the perf baseline before shipping count-up.
