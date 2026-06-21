# 03 — THE CONSOLIDATED MASTER PLAN (v8 final-verification front)

> **Status:** DEFINITIVE execution-ready merge. The single dependency-ordered plan the
> autonomous run follows end-to-end, plus the per-slice documentation convention.
> **Author:** v8 verification seat (consolidated-master-plan front), 2026-06-18.
> **READ-ONLY** — no app code changed by this document.
>
> **What this is.** The de-duplicated, reconciled MERGE of the entire 7-pass planning body:
> - **Spine:** `v4-readiness/00-FINAL-BUILD-PLAN.md` (41 slices · 4 CRITICAL · 17 production gaps N1–N17 · go-live blockers).
> - **+ design coverage:** `v3-coverage/00-COVERAGE-MATRIX.md` + `00-FINAL-ROADMAP.md` (33/38 design gaps).
> - **+ optimal/wow:** `v5-optimal/00-OPTIMAL-AND-WOW.md` (A1–A8 · the two-track rule · 5 primitives · W4 composite).
> - **+ AI-ready foundation:** `v6-ai-autonomy/00-AI-NATIVE-PLAN.md` (IAiProvider + IDecisionProvider seams · dual-mode · autonomy levels · fabrication firewall).
> - **+ domain/DMS:** `v7-domain-dms/00-DOMAIN-AND-DMS.md` (Wave 5 FLOW-0..4 · X1–X5 · DOM tail · the should-exist register).
> - **+ law:** `v2/DECISIONS-LOCKED.md` (D.1–D.5) · `DESIGN-NORTH-STAR.md` (doctrine) · `SECURITY-POSTURE.md` (P0/P1/P2).
>
> **Every load-bearing feasibility claim in this doc was re-verified against real code** (file:line in §0).
> Where a claim across the body was UNTRUE on the tree, it is corrected here and flagged a must-resolve item.

---

## 0. VERIFICATION LOG — what I re-checked in real code (the gate's evidence)

| # | Claim under test (which doc asserts it) | Code reality (verified this pass) | Verdict |
|---|---|---|---|
| V1 | Consent calc is binary by-heads, fractions stored-but-unread (v4 B0 / v7 G2) | `projects.service.ts:419–421` — `consentedPct = apartmentsConsented/totalApartments`; `metThreshold = consentedPct >= targetSignaturePct`. The share CTE reads `relationship='owner'` counts, **never** `share_numerator/denominator`. | ✅ **TRUE.** B0 is real and correctly the most dangerous defect. |
| V2 | `projects.update()` is any→any, no version predicate (v4 B5 / N1+N2) | `:773` sets `patch.status = input.status` unconditionally; `:803` `UPDATE … WHERE eq(projects.id, id)` — **no `updated_at`/version predicate**. Audit logs before/after but does not gate the write. | ✅ **TRUE.** B5's two halves are both real and unbuilt. |
| V3 | Scheduler ALREADY exists; B3 = "add a consumer" not "build a scheduler" (v4 B3 re-scope / v5 / v6) | `apps/worker/src/main.ts` runs **3 scheduled cron consumers** (reaper hourly `:245`, audit-retention daily `:274`, signature-expiry hourly `:309`) + the import handler, on a clean `registerHandler→boss.schedule` pattern. | ✅ **TRUE.** v3-roadmap's "zero schedulers / NET-NEW infra" premise is **factually wrong**; v4's re-scope is correct. B3/loop = a 4th consumer. |
| V4 | The 3 new notification kinds are absent (v4 B3 / v3 C-i) | `shared-types/src/notification.ts:12–22` — exactly **8 kinds**; none of `expiring`/`stalled`/`threshold_reached`. | ✅ **TRUE.** B3 must add 3 kinds + link targets. |
| V5 | Tabu extraction runs on a deterministic Stub (v4 N11 / v6 #1) | `extraction-provider.factory.ts` returns `new StubExtractionProvider()`; the Gemini branch is a commented seam. | ✅ **TRUE.** N11 honesty gate is real; v6's "drop-in behind IExtractionProvider" is exact. |
| V6 | `documents` has no `owner_id`/`building_id` parenting (v7 FLOW-0) | `schema/artifacts.ts:23–31` — only `project_id` + `apartment_id` nullable FKs. | ✅ **TRUE.** FLOW-0 additive migration is net-new and required by the per-owner lens + matcher. |
| V7 | `actor_type` CHECK = `('user','system','provider')` (v6 `+'ai'` · v7 `+'external'`) | `artifacts.ts:297–299` confirms exactly those 3. | ✅ **TRUE.** Both widenings are real migrations (schema-constraint-ripple caution applies). |
| V8 | `PostgresCacheProvider`/`cache_kv` exists, wired only for export rate-limit (v4 PERF / v5) | `packages/db/src/providers/cache/postgres.provider.ts` + `cache.interface.ts` + `fake.provider.ts` all present. | ✅ **TRUE.** PERF is read-through wiring + a perf test, NOT net-new infra. |
| **V9** | **M0b "marked COMPLETE / landed as PR #413" (v3-roadmap line 63, v4 line 209/234)** | **FALSE on the tree.** `components/ui/` has **no ConfirmDialog, no toast/live-region**; **13 `window.confirm` still live** in `apps/web/src`; the work exists ONLY on the unmerged `fix/styled-confirm-dialog` branch (`becce1d`). v5 §2 independently caught this: *"the FE primitive layer is missing… building two small primitives, not restyling."* | ❌ **MUST-RESOLVE #1.** PR #413 is unsubstantiated. M0+G6 + ConfirmDialog are a hard Wave-0 PRECONDITION, not "already done." |

**Net effect of §0:** every CRITICAL/feasibility claim the autonomous run depends on holds in code —
**except the single biggest mis-statement**, the "ConfirmDialog already shipped" claim (V9), which is
false and is promoted here to a Wave-0 build precondition. That one correction is the gate's payoff.

---

## 1. RECONCILIATION — how the 7 passes fit into ONE plan (no double-counting)

The seven passes are NOT seven competing plans; they are **concentric layers** around one spine. The
reconciliation rule for the autonomous run:

1. **v4 FINAL-BUILD-PLAN is the SPINE.** Its 41 slices, 4 CRITICAL items, N1–N17, and go-live-blocker
   set are authoritative for Waves 0–4. v3-roadmap is its parent and is fully absorbed (v4 added N1–N17
   on top); **do not execute v3-roadmap separately.**
2. **v5 = additive layers ON v4 slices, never replacements.** A1 (reminder-memory column) is a tiny new
   BE slice before B3; A2/A3/A5/A8 are derivations folded into B1/B3/E2.1; the two-track rule + 5
   primitives + W4 composite are folded into the universal DoD and named slices. **v5 explicitly rides
   the certainty gates, never bypasses them.**
3. **v6 = the AI-READY FOUNDATION (deterministic, zero LLM) as a TAIL of the autonomy story, plus a
   later owner/DPA-gated AI wave.** The foundation does NOT touch Wave 0's ordering gate; the AI wave is
   gated on a legal/DPA decision, not engineering. RuleDecisionProvider **IS** v5's A2 ranker — one
   artifact, two names; build it once.
4. **v7 = Wave 5 (document-FLOW + external-exchange) + the DOM domain tail.** Depends only on Wave 0
   (S0-SEC + PERF) + additive parenting; otherwise independent of Waves 1–4. Does **not** delay the
   critical path.
5. **Security program (P0/P1/P2)** folds: P0 → S0-SEC + ops checklist; P1/P2 → into natural slices + an
   eng-hardening mini-wave alongside Wave 4.

**De-duplication map (the same work under different names — build ONCE):**

| One artifact | Named in | Build as |
|---|---|---|
| The next-best-action ranker | v5 A2 · v6 `RuleDecisionProvider` | ONE pure scoring function over the B1 pulse row (extends B1) |
| The live-region / undo-toast | v3 M0+G6 · v5 primitive #3 · v4 M0+G6 | ONE Wave-0 primitive (currently MISSING — V9) |
| ConfirmDialog | v3 A7/M0b · v5 §2 "missing primitive" · v4 (wrongly "shipped") | Land/rebase `fix/styled-confirm-dialog` in Wave 0 (MUST-RESOLVE #1) |
| The autonomy loop's heartbeat | v6 4th consumer · v4 B3 · v5 Action-Queue | ONE pg-boss cron consumer (B3) + the action_queue (v6 foundation) |
| Reminder cadence memory | v5 A1 · v6 LEARN step | ONE additive migration (`reminder_count` + `last_reminded_at`) before B3 |
| The campaign dry-run / preview | v4 N8/M5 · v5 A4 · v7 X4 package preview | ONE preview pattern, instantiated per surface |
| Tabu extraction engine | v4 N11 · v6 #1 · existing Stub | ONE seam (`IExtractionProvider`); ship Stub+manual-label OR Gemini |

---

## 2. THE BINDING RULES + UNIVERSAL DoD (apply to EVERY slice — verbatim, non-negotiable)

These are carried unchanged from v4 §A and extended with v5's two-track rule and v6's six AI-safety rules.

### 2.1 The interim consent-basis-label rule (the single most important written rule)
Until the statutory basis is legally confirmed (🔒 OD-1), **no slice may render an unqualified consent %
as a legal or threshold claim.** Every % carries its denominator label ("לפי שיעור הבעלות" vs "לפי ראשי
דירות") and leads with the plain-Hebrew count sentence ("23 מתוך 40 דירות חתמו"). D.1 locked
share-weighted as the headline basis; only the exact statutory % stays legal-gated. Board-first, C1, M3,
the tenant portal, **and every external package (X4)** inherit this rule.

### 2.2 The DO-NOT-FABRICATE register (binding on every FE slice)
Never render a signal the backend cannot honestly back:
- future-nudge ("נזכיר שוב בעוד N ימים") → ❌ until **B3**; ship only past-tense "נשלחה תזכורת לאורי".
- objection count/reason ("N בעלים מתנגדים") → ❌ until **B2**; substitute "X דירות סומנו כסירוב".
- pulse buckets / "+N השבוע" / "אין תנועה N יום" / forecast → ❌ omit until **B1**.
- the holdout's NAME → ❌ until **B4**; show "דירה 7 · partial" meanwhile.
- "the system acted" claims → ❌ until **B3**.
- Campaign "נשלח ל-N" → MUST also show the `failed` count (N7) — surface a failure the backend DID detect.
- Any unqualified consent % → ❌ always until OD-1.
- **Anticipatory expiry (v5 A5) is ALLOWED** — "3 חתימות פגות בעוד 5 ימים" is read-only arithmetic, NOT a
  fabrication. But "נזכיר שוב בעוד 5 ימים" stays B3-gated. The present/future-arithmetic vs future-promise
  distinction is the whole game.

### 2.3 The two-track action rule (v5 — write into the DoD)
Every new action declares its track. **Reversible (the 95%: resend, archive, status, assign, role
grant/revoke, share revoke, member remove) ⇒ instant + undo-toast, MUST NOT get a confirm.** Irreversible
(campaign SMS fan-out, RTBF erase, the `approved` legal transition) ⇒ preview → ONE justified confirm →
narrated result. One confirm the user always reads beats ten he learns to ignore.

### 2.4 The six AI-safety rules (v6 — apply to any slice that touches the AI seam)
1. **Fabrication firewall** — LLM output is advisory + Zod-validated, written ONLY to a staging table,
   NEVER to a fact column (consent/status/share/signed_at) except through an audited human-confirm method.
   Enforced by a guard test (mirrors `app-no-new-inline-colors.spec.ts`).
2. **PII boundary** — no `national_id`/`phone`/signature reaches a draft/explain/rank provider
   (fail-closed regex scrub); the one exception is the tabu-extract bytes path, gated on
   `ai_extraction_enabled` + DPA + finalized+clean.
3. **Audited + attributed** — every AI call + human accept/reject writes an `actorType:'ai'` audit row;
   the 'עוזר AI' badge renders; never attributed to a human or 'המערכת'.
4. **Reversible/gated** — reversible AI actions use undo; irreversible/legal-fact ones ALWAYS require the
   human confirm with the rationale + `sourceSignals` shown in the dialog.
5. **Degrades safely** — engine absent/erroring/rate-limited ⇒ deterministic fallback with ZERO feature loss.
6. **Never fabricates** — the consent % is handed to the explainer as the rendered number, never raw rows.

### 2.5 The universal Definition of Done (green-gate, no exceptions)
`pnpm typecheck && pnpm lint && pnpm test` green — **including** the inline-color ratchet
(`app-no-new-inline-colors.spec.ts`), the class-name leak guard (Wave 0), the input-validation-coverage
guard (S0-SEC), `app-forms-no-get-fallback.spec.ts`, the AI-fabrication firewall guard (once the AI
foundation lands), and adapter/sidebar specs — **AND** a real-Chrome **4-axis verify** (Network / URL /
Cookies / Redirect, `docs/DOD-BROWSER-SMOKE.md`) **per affected role** — **AND** a **perf-budget check**
(warm 200ms; the seeded-50-project gate where the slice touches `orgStats`/`signatureProgress`) — **AND**
a **North-Star check** (reduces actions, plain Hebrew, never fakes a signal, stays re-skinnable). Routes
are **never deleted** (re-composition, not re-routing). New endpoints add a `gen-api-docs` ENDPOINTS entry
(the api-docs-coverage guard fails CI otherwise) and land validated by the global pipe (S0-SEC).
**Security-sensitive slices (PII/auth/RLS/external-write) run `@security-reviewer` BEFORE commit.**

---

## 3. THE WAVE ORDER — end-to-end, dependency-ordered (the autonomous run's spine)

```
WAVE 0  Foundation + security/perf/primitive gate   (zero screen redesigned; everything depends on it)
   │      S0-SEC ⭐ → PERF ⭐ → M0b(land ConfirmDialog) → M0+G6 live-region → tokens/guards/tz/DataState
   ▼
WAVE 1  Structural redesign + consent + integrity     (B0 ⭐ + B5 ⭐ are the certainty gate)
   │      B0 (gated on PERF) · B5 (gated on S0-SEC) · board-first tabs · sidebar 14→5 + S4 · auth re-skin
   ▼
WAVE 2  Backend-gated surfaces                         (run B1 in parallel with Wave-1 FE)
   │      B1 pulse(+A2 ranker +A5 expiry +A8 triage) · B4 holdout-name · home · board · M2 chase · list
   ▼
WAVE 3  The "movie" + honest autonomy                  (gated on backend + owner)
   │      A1 reminder-memory → M3 wow · B3 ⭐(consumer+3 kinds) · M5 campaign+preview+failed · B2 why-layer
   ▼
WAVE 3.5  AI-READY FOUNDATION (deterministic, zero LLM)  (tail of the autonomy story; non-blocking)
   │      IAiProvider+Noop · IDecisionProvider(=A2) · action_queue+autonomy config · actorType:'ai' migration
   ▼
WAVE 4  Completeness + operator control                (long tail, sequenced; contains go-live blockers)
   │      C1 ⭐ · C12b ⭐(recovery) · C16(DSAR/RTBF) · C5 · C8 · C7 · C14 · C15 · C12 · C17 · N11 · C10 · C11 · M6 · C-c/d/l
   │      ∥ eng-hardening mini-wave (P1.5/P1.6/P2.1–P2.4) — pure-engineering, no design dep
   ▼
WAVE 5  Document-FLOW + external exchange (v7)          (depends only on Wave 0; the "complete JOB")
   │      FLOW-0→1→2/3→4 · X1→X2→X3→X4→X5 · DOM-PKG · DOM-1/2 · renter axis (extends C10)
   ▼
WAVE 6  The AI wave (owner/DPA-gated)                   (clean config-flip swap; removable in reverse)
          GeminiAiProvider · GeminiDecisionProvider · EXTRACTION_ENGINE=gemini(#1) · draft(#2) · digest(#3)
```

**The two hard ordering laws (never reorder):**
1. **S0-SEC lands FIRST** (before B0/B1/B4/B5/B2) so every new BE surface is validated by construction (N12).
2. **PERF lands before B0** so the heavier share-weighted CTE is proven sub-second at 50 projects (N9).

Waves 5 and 6 are **independent of Waves 1–4** (need only Wave 0) and may begin once Wave 0 is closed if
the owner prioritizes the document JOB — but they do not preempt the go-live-blocker set in Waves 0–4.

---

## 4. THE FULL SLICE TABLE (consolidated, de-duplicated, every slice concrete)

Legend: ⭐ CRITICAL · 🔒 owner/legal/ops-gated · 🚧 GO-LIVE BLOCKER · BE/FE · deps in `()`.

### WAVE 0 — Foundation + security/perf/primitive gate

| Slice | What (concrete) | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **S0-SEC** ⭐🚧 | Global `APP_PIPE` (`GlobalZodValidationPipe`) + `@ZodBody/@ZodQuery` metadata + explicit `@RawBody/@NoValidation` for the 4 exceptions (documents `:id/content`; auth+provider-auth `refresh`/`logout`). NEW CI guard `input-validation-coverage.spec.ts` (static scan of every `*.controller.ts`). + P0.3 regression lock (`CreateOwnerDto.safeParse({national_id:'123456789'})` fails). | `main.ts`, `app.module.ts`, every `*.controller.ts`, new spec | BE | **N12 — LANDS BEFORE B0/B1/B4/B5/B2.** SECURITY P0.1+P0.2+P0.3. |
| **PERF** ⭐ | Read-through `PostgresCacheProvider`/`cache_kv` over `orgStats` (`projects.service.ts:537–581`) + `signatureProgress` (`:355–435`), tenant-scoped keys + write-invalidation. Seeded **50-project perf test** (warm <200ms) that B0 MUST pass. (Cache provider EXISTS — wiring only.) | cache wiring in `projects.service.ts`; seeded perf spec | BE | **N9 — gates B0.** |
| **M0b** 🚧 **[MUST-RESOLVE #1]** | **Land/rebase `fix/styled-confirm-dialog` (`becce1d`) onto the E2 baseline + migrate the 13 live `window.confirm`.** Verified NOT on the tree (§0 V9). Then ratchet the class-guard over it. | `components/ui/confirm-dialog.tsx` (from branch); 13 confirm sites | FE | **A7 — NOT "already shipped"; a real precondition for every Wave 2–4 confirm.** |
| **M0+G6** | ONE app-root `role="status" aria-live` live-region = BOTH the ActionToast (auto-dismiss, pause-on-hover, undo, concurrent settle) AND the a11y G6 region. Migrate ALL ~11 bespoke "saved" sites (6 settings configs + role-editor + member-caps/overrides). Follow ConfirmDialog a11y contract. | new live-region; settings/members feedback sites | FE | v5 primitive #3 — currently MISSING (V9). Absorbs coverage B2. (M0b) |
| **E2.0 — Tokens** | Tier-2 semantic block + semantic Tailwind mappings + `--space-1..12` & `--text-display..caption` (Heebo 400/500/700) + fix 3 bugs (dead `bg-card` ×41, `--r-lg` 12vs8px, `borderRadius.lg`). Brand → `--brand→--navy-900` (D.5). | `globals.css`, `tailwind.config.ts` | FE | Additive; ratchet + typecheck prove it. |
| **E2.0-GUARD** | Class-name leak guard (`(bg\|text\|border\|ring)-(gray\|slate\|emerald\|…)-[0-9]` in `components/**`+`app/**`). **RE-MEASURE baseline across the FULL tree incl. Provider subtree + all `*/new` + settings/member panels** before freezing. | new `*-no-default-palette-class.spec.ts` | FE | **A8·A9 — false-floor risk.** |
| **E2.0b** | Re-home `status-badge.tsx` + `Button.destructive` → token `.badge-*`; rename `statusColor` → intent (`success\|warning\|danger\|info\|neutral`) across VM + 6 adapters + 3 specs. | listed VM/adapters/specs | FE | `adapters/*.spec.ts` guard the rename. |
| **M1 — Motion tokens** | `--motion-duration-{fast,base,slow}` + `--motion-ease-*` + `prefers-reduced-motion` (zero durations under reduce). | `globals.css` | FE | Reconcile count-up vs LCP (G-MOTION-PERF) before M3. |
| **P-TZ-1** | `formatRelative` (18 adapters) → pin "now" + target to Asia/Jerusalem before diffing + UTC-boundary test. + ICU-plural + native-Hebrew copy ("שתי חתימות"). | `lib/format.ts` + test; i18n catalogs | FE | Gates chase-loop honesty. Absorbs B12. |
| **C2 — DataState** | ONE wrapper: loading skeleton / calm error+retry / 403 access-denied muted / guided empty. **Kill silent-null** (`signature-progress-board.tsx` returns bare `null`). | new `DataState`; board; `ListSkeleton` | FE | v5 primitive #5 (Failure-Grace). Absorbs C-j. (M0+G6) |
| **N15 (do now)** | env-gated `CAMPAIGN_SEND_ENABLED` kill-switch in the campaign service (1 line, below org-suspend). | campaign service | BE | Cheap insurance. |

**Wave-0 owner decisions to clear:** 🔒 OD-5 (`en` a real locale?) · OD-6 brand (D.5, confirm) · doctrine
lines (no-session-countdown UX, PII-egress cue, bidi-interpolation guard, G-MOTION-PERF).

### WAVE 1 — Structural redesign + consent + integrity

| Slice | What | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **B0** ⭐🚧 🔒OD-1 | Re-author `signatureProgress` (`:355–431`, binary at `:419–421`): share-weighted CTE over `ownerships.share_numerator/denominator` (mig 0065, sum=1) + per-building GROUP BY + partial-share decision (OD-3) + SHELL-owner denominator. **Pin wire:** keep `metThreshold` (now share-basis) + `consentedPct` (by-heads supporting) + add `consentedShare`/`metThresholdByShare`/`byBuilding[]`. **+ FIX portal denominator (N4):** `adapters/portal.ts` reads 100% at 10/35. **+ EXTRACT `ConsentCalcService`** (N9 SOLID). + re-skin `apartments/[id]/ownerships/page.tsx`. | consent block→`ConsentCalcService`; `adapters/portal.ts`; ownerships page; specs; `shared-types/project.ts` | BE+FE | **🔒 D.1 locked — NOT blocked; statutory % behind A.1 label. MUST PASS PERF.** (PERF, S0-SEC) |
| **B5** ⭐🚧 | TWO halves, ONE slice: **(i)** state machine over D.18 enum (replace `:773` any→any) + `metThreshold` precondition for `approved` → `invalid_status_transition`; **(ii)** If-Match/`updated_at` optimistic-concurrency on `:803` (no version predicate today) → `stale_write` 409. Unit tests per edge. | `projects.service.ts:762–816`; transition map; If-Match plumbing | BE | **N1+N2 — before any board-first 'approve'.** No migration. (S0-SEC) |
| **E2.2-S1** | Flip default tab `'tenants'→'signatures'`; re-order tabs; inline empty-CTA. | `project-detail.client.tsx:79` | FE | Default+order ONLY (merger deferred). Basis label from render 1. |
| **E2-IA-S2** | Sidebar 14→5 + Admin group (`sidebar.tsx:113–145`); keep ALL routes. | `sidebar.tsx`; `(dashboard)/layout.tsx` | FE | **Ship S4 same slice (D.4).** Per-role smoke. |
| **S4** | Global search omnibox extending `POST /owners/search` (PII-in-body, `view_owner_pii`-gated); no `?q=` PII param. | `owners.controller.ts:72` (reuse) | FE(+BE reuse) | Same wave as sidebar (D.4). |
| **C13** | Token re-skin of login·signup·forgot·reset·accept-invite·tenant/login·provider login; keep `method="post"`. | auth pages | FE | No auth-path logic change. |

### WAVE 2 — Backend-gated surfaces

| Slice | What | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **B1 (+A2/A5/A8)** | `GET /org/signature-pulse` (no migration). `{buckets, attention: ProjectPulseRow[]}`. Pin row: `lastSignatureAt`/`signedThisWeek`/`stalledDays`/`nextExpiryAt` (join defined from `signature_requests`+`documents.project_id`). Reuse `orgStats` + agent-scope CTE. **+ A2: `rankAttention()`** pure scorer (= `RuleDecisionProvider`). **+ A5: `expiringSoon`** derived field. **+ A8: `needsHuman[]`** bucket (no-phone/objecting/past-N-reminders). Reads through PERF cache. | new route+service; `shared-types` ProjectPulseRow; `gen-api-docs` | BE | Stub `**/api/v1/org/signature-pulse` in specs. Closes A5·A6·N10(view). (PERF) |
| **B4** | `GET /projects/:id/signature-progress/apartments/:apartmentId/holdouts` → `{holdouts:[{ownerId,name(NameDisplay),apartmentNumber}]}`. `view_owner_pii`-gated, audited (like reveal-pii), no national_id/phone. | new route on `projects.controller.ts`; audit | BE | **A4 — M2 chase depends on it.** Mirrors `reveal-pii`. (S0-SEC) |
| **E2.1 — Home** | Replace KPI grid + DELETE calendar stub (`manager-home.tsx:115–139`); greeting + 1 pulse sentence + ≤5 ranked ActionCards (consume A2) + explain-chip (v5 #2) + calm-home reward empty-state (v5 #4). Migrate to Pattern A (RSC+Zod+TanStack). **Route Viewer to read-only mission-control** (B11). Clean AgentHome's ~15 inline leaks. Retire/repoint `/org/stats` (C-g). | `manager-home.tsx`, `agent-home.tsx`, `(dashboard)/page.tsx` | FE | Without B1: structure on distance-signals, omit momentum. (B1, M0+G6) |
| **E2.2-S3** | Lift board to default surface; real `ThresholdProgress` (progressbar + aria-valuetext + basis label); "מי תקוע" named list. Never `null` (C2). | board; `ThresholdProgress` | FE | Holdout name via B4; else "דירה 7 · partial". (B4 for names) |
| **M2 — chase loop** | `resendSignatureRequest` (`postIdempotent`) over `POST /signature-requests/:id/resend` (`:142`) + `useRemindSignatureRequest` (optimistic; `prev`=undo) + ONE `<RemindHoldoutButton>` (home/board/owner). Calm `recipient_not_associated` (409) envelope (B6). Explain-chip (v5 #2). | `lib/api/signature-requests.ts`; new button | FE | **No future-nudge until B3.** (M0+G6) |
| **E2-list** | `ProjectRow` enrichment + filter-by-status + sort-by-distance (zero BE) + URL-state + גוש/חלקה. Sort-by-momentum/expiring wires to B1. | `projects-list.client.tsx`; `project.vm.ts` | FE | Sort-by-momentum gates B1. Action-half of triage = C17. |

### WAVE 3 — Movie + honest autonomy

| Slice | What | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **A1 — reminder-memory** | Additive migration: `signature_requests.reminder_count int DEFAULT 0` + `last_reminded_at timestamptz` + UPDATE in resend path. (v5 A1; confirmed missing `schema/artifacts.ts:148–162`.) | migration; resend path | BE | **Before B3** (cadence needs it). Feeds A2/A3/A4. Gate-6. |
| **M3 — Wow 1+2** | "כמעט שם" finish-line + threshold-bar fill + on-screen "crossed the line" (client edge-diff of `metThreshold`). Calm, never confetti. | home + board | FE | **Inherits A.1/B0 basis gate.** Reconcile G-MOTION-PERF first. |
| **B3** ⭐🚧 🔒owner(infra) | **Scheduler EXISTS (3 sweeps verified §0 V3).** Add ONE pg-boss cron consumer + **3 notification kinds** (`expiring`/`stalled`/`threshold_reached` — confirmed absent §0 V4) + FE deep-link targets (`notification-links.ts`); post-B2 drive auto-reminders. Concurrency-1 `withTenant` pattern. | new consumer in `apps/worker`; `notification.ts` kinds; `notification-links.ts` | BE | **Unlocks "keeps nudging" copy.** Emits threshold-reached (C11 seed). (A1) |
| **M5** | Campaign send in the ONE justified ConfirmDialog; success → M0. **+ N7: surface `failed`** + drill-down (`signature-requests.service.ts:482–534`, discarded by toast). **+ N8: preview** `POST /projects/:id/signature-campaign/preview` (who/excluded/no-phone) in the confirm. | campaign UI; ConfirmDialog; new preview route; `gen-api-docs` | FE+BE | C-k: agent without `manage_signatures` must NOT see it. (M0b, M0+G6) |
| **B2** 🔒Gate-6 | `ALTER signature_requests ADD decline_reason text` + widen status CHECK `'declined'` (mirror 0063) + "סמן כמתנגד" + unhide "N מתנגדים". **+ N13 `withdrawn` lifecycle** (owner/legal: in MVP?). Hand-author `.sql`+`_journal.json`. **Ripple:** STATUS_LABELS, intent map, contractor status, every raw seeder. | migration; service; status maps; seeders | BE | Until merged "N מתנגדים" omitted. (S0-SEC) |

### WAVE 3.5 — AI-ready foundation (deterministic, zero LLM, non-blocking)

| Slice | What | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **AI-FND-1** | `IAiProvider` + `NoopAiProvider` + token + `aiProviderFactory` (Noop default, **no prod fail-fast**) + `CircuitBreaker` + `PiiRedactor` egress-scrub + Zod pipeline. | `packages/db/src/providers/ai/*`; `ai-provider.factory.ts` | BE | Mirrors the 5 existing seams. Zero PII egress, zero cost. |
| **AI-FND-2** | `IDecisionProvider` + `RuleDecisionProvider` (**= the A2 ranker** — build once). | decision seam; reuse B1 `rankAttention()` | BE | Useful day one without any LLM. (B1) |
| **AI-FND-3** | `action_queue` table + proposing/dedupe + autonomy-level config (org default + per-project override + eligibility caps + resolver) + `actorType:'ai'` CHECK migration (`artifacts.ts:299`) + `ai.invoke` audit + cost-meter `cache_kv` keys + the fabrication-firewall guard test. | migration; action_queue; autonomy resolver; guard spec | BE | The PROPOSE surface. Schema-constraint-ripple caution. |

### WAVE 4 — Completeness + operator control

| Slice | What | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **C1** ⭐🚧 🔒owner(PDF-vs-print) | Committee print-of-record carrying the **basis-labeled** tally. v5 downgrades to PARTIAL: reuse `pdf-signed-document.renderer.ts` with a new template (not a new renderer). MUST carry basis label + PII-egress cue. | new template OR `projects/:id/consent-record` route | FE or BE | **P0-class.** Unlabeled printed % = worst fabrication. (B0) |
| **C12b** ⭐🚧 🔒owner(scope) | **GO-LIVE BLOCKER subset:** MFA-reset + unlock + resend-invite (today `provider-tenant-users.controller.ts:59` read-only → first lockout needs raw DB). Fuller set (deactivate, cross-tenant search, impersonate) + N14 job retry/drain = post-MVP. | new `provider/*` controllers+UI; health drain/retry | BE+FE | **N5.** v5: the only full-stack rebuild. (S0-SEC) |
| **C16** 🚧 🔒owner(DSAR scope) | **GO-LIVE BLOCKER subset:** GDPR DSAR `GET /owners/:id/data-export` + RTBF `POST /owners/:id/erase` (`owners.controller.ts:128,139`, irreversible → confirm design) UI. Then member-overrides PUT/DELETE. | new admin surfaces; reuse controllers | FE(+confirm) | **N6.** (M0b for RTBF confirm) |
| **C5** 🚧(N16) | Re-skin `projects/new/page.tsx` (1468 lines) "propose-don't-ask". **N16: persist or stop collecting `unitType`/`areaSqm`** (`:273` drops on wire). v5 A6: re-frame to "propose-and-approve". | `projects/new/page.tsx` (+ optional schema) | FE(+small BE) | P1. (E2.0-GUARD baseline) |
| **C8** | Re-skin live-SSE import (`use-import-progress.ts`); M1/G6 reconcile. **N17: note SSE 30-stream cap → LISTEN/NOTIFY post-MVP.** C-b national_id-mandatory, no shell concept. | `imports/*` | FE | P1. |
| **C7** | Re-skin contractor share (`contractor/share/page.tsx`); restore dropped lifecycle status; reconcile `external_read` role vs cookie path (G9). | `contractor/share/page.tsx`; `contractor-read.controller.ts` | FE | P1. (overlaps v7 X2 — reconcile) |
| **C14** | Re-skin tenant portal (770 lines) + tenant/login OTP. **P1.2:** `isValidIsraeliPhone` into OTP schemas. Portal % fixed in B0 (N4), not here. | `portal/page.tsx`, `tenant/login`, otp schemas | FE(+BE) | P1. |
| **C15** | Messages topbar cluster: optimistic send + toast + 6 `messaging.controller.ts:34–73` routes + `/messages?c=` deep-link. | new topbar panel | FE | P1. |
| **C12** | Re-skin 8 provider pages + `PCSidebar`; kill hardcoded `bg-emerald/amber/red`. **P1.3:** provider `ParseUUIDPipe`→Zod. | `provider/**`, `pc-sidebar.tsx` | FE | P1. |
| **C17** | **N10:** bulk verbs (archive/status/resend — net-new bulk routes; `projects.controller.ts` is single-`:id`) + saved views + cross-project "expiring this week" (feeds B1). v5 A4 bulk-by-intent rides here. | new bulk routes; saved-view persistence; `gen-api-docs` | BE+FE | P1. (B1, E2-list) |
| **N11** 🚧 🔒owner | Tabu honesty: ship **labeled manual-entry** OR build real `IExtractionProvider` (Stub confirmed §0 V5). Never ship "extraction" over the stub in prod. | `extraction-provider.factory.ts`; review UI label | BE(+UI) | **Honesty gate.** |
| **C10** 🔒owner(scope) | Discovery FE (`discovery_records` mig 0066, BE-only). Correct dead renter-exclusion (`RelationshipSchema=z.enum(['owner'])`). | `apartments/[id]/discovery` | FE | P2. (extends to v7 renter axis) |
| **C11** 🔒owner(scope) | Populated calendar (net-new `GET /calendar` if scoped) + notifications-as-momentum + multi-user 409 ("כבר נשלח על ידי [שם]"). | new `GET /calendar`; notifications | BE+FE | P2. (B3) |
| **M6** | StepUpDialog a11y retrofit (ESC/trap/aria-describedby). Reconcile owner-PII reveal gate (C-f). | `StepUpDialog`; reveal surface | FE | P2. |
| **C-c/C-d/C-l** | Milestone overlay decision · member-override Admin surface (overlaps C16) · fix stale inventory numbers. | listed | FE/— | P2. |
| **ENG-HARDEN** ∥ | P1.5 `--prod` dep-audit · P1.6 method-level auth ratchet · P2.1 array `.max()` · P2.2 per-route `bodyLimit` · P2.3 sign `:token` `.max()` · P2.4 doc-scan inline→worker. | per SECURITY-POSTURE | BE | Pure-eng, no design dep. |

### WAVE 5 — Document-FLOW + external exchange (v7)

| Slice | What | Files / endpoints | BE/FE | Gate · deps |
|---|---|---|---|---|
| **FLOW-0** | Additive `documents.{owner_id,building_id}` FKs (confirmed absent §0 V6). No backfill. | migration; `schema/artifacts.ts` | BE | Unlocks per-owner lens + matcher. (Wave 0) |
| **FLOW-1** | `document_requirements` spine (RLS FORCE) + the §2.3 per-entity-type template **seeded-but-editable per-org** + Zod + CRUD. | migration; service | BE | Idempotent re-seed; migration-silent-skip caution. (FLOW-0) |
| **FLOW-2** | Suggest-confirm fulfillment matcher (doc→requirement) + per-entity status roll-up + RECEIVE-via-signing/sharing hooks. | service | BE | Suggest-then-confirm (DO-NOT-FABRICATE). (FLOW-1) |
| **FLOW-3** | `tasks.{requirement_id,owner_id}` FKs + `document_chase` task minting/auto-close + 2 notification kinds (`document_requested`/`document_overdue`) + overdue sweep. | migration; tasks; notifications | BE | 🔒 enum migration → ripple scan. (FLOW-2) |
| **FLOW-4** | Three lenses: per-project flow-board · per-entity checklist · org-wide missing-queue. | new FE surfaces | FE | (FLOW-2/3) |
| **X1** | `external_parties` + `external_exchanges` (`expires_at`+`direction`+doc-set `.strict()` scope) + `defaultExternalScope(kind)`; reuse share token/guard. | migration (RLS FORCE) | BE | RLS-isolation spec. (Wave 0) |
| **X2** | RECEIVE viewer: generalize `contractor-read` to doc-SET scope; view-only vs download; sensitive behind OTP. | `contractor-read` generalization | BE+FE | IDOR + no-PII spec; walk as real שמאי. (X1) |
| **X3** 🔒SECURITY | PROVIDE upload-back: first `@Post` external tier over existing scan+encrypt; `expected_types` allow-list; rate limit; lands as received doc; fires missing→received. | new external write route | BE+FE | **`@security-reviewer` before commit.** (X2, FLOW-2/3) |
| **X4** 🚧 | Package builder: `PackageTemplateService` (§2.3 reversed) + `POST /projects/:id/packages` + preview/dry-run (who/what/missing/sensitive) + receipt. | new package route; reuse export composer | BE+FE | Missing-item-warns spec. (X1+X2; ideally X3) |
| **X5** 🔒owner/legal | `actor_type='external'` migration (`artifacts.ts:299`) + per-external-read audit (retrofit contractor) + PDF watermark + `otp_required` default + token-secret split. | migration; watermark; OTP | BE+FE | Owner: watermark text + OTP channel + boot env. (X4) |

### DOM tail (Wave-4-tail / post-MVP, owner-scoped)

| Slice | What | Class | Slot |
|---|---|---|---|
| **DOM-PKG** 🚧-adjacent | Filing-package generator (signed docs + basis tally + roster + נסח → immutable bundle). | New(small) | Leans on C1 + X4. P0 G3. |
| **DOM-1** | Estate/POA/multi-heir/company/minor representation over `ownerships`. | New | P1 G8. Activates `conditional` POA reqs. |
| **DOM-2** | Document retention / legal-hold by class (audit-retention cron precedent). | New | P2 G11. Near C16. |
| **DOM-3/4/5/6** | Per-owner deal-terms · permit/decision entity · relocation+rent-comp · second execution-signing round. | New | P1/P2 post-MVP. |
| **Renter axis** | Retire `RelationshipSchema=z.enum(['owner'])` + renter relocation RECEIVE checklist. | Partial | Extends C10. G10. |

---

## 5. THE GO-LIVE BLOCKER SET (must ship before the first paying customer)

| # | Blocker | Wave | Gate |
|---|---|---|---|
| 1 | **S0-SEC** — global pipe + CI guard (every BE surface validated by construction) | 0 | eng |
| 2 | **B5** — state-machine + optimistic-concurrency (no silent legal/business corruption) | 1 | eng |
| 3 | **B0** — share-weighted consent + portal denominator (the legal number, behind A.1) | 1 | 🔒OD-1 (build not blocked) |
| 4 | **PERF** — cache + seeded-50 gate (B0's heavier CTE proven sub-second) | 0 | eng |
| 5 | **M0b + M0+G6** — ConfirmDialog + live-region **(MUST-RESOLVE #1: NOT shipped; precondition for every confirm/undo)** | 0 | eng |
| 6 | **C12b subset** — MFA-reset + unlock + resend-invite (first lockout otherwise needs DB access) | 4 | 🔒owner |
| 7 | **C16 subset** — GDPR DSAR + RTBF UI (compliance liability with no surface) | 4 | 🔒owner |
| 8 | **C1** — committee print carrying the basis label (the raison d'être) | 4 | 🔒owner(PDF-vs-print) |
| 9 | **N11** — tabu honesty (labeled manual-entry OR real parser; never "extraction" over the stub) | 4 | 🔒owner |
| 10 | **N16** — wizard persist-or-stop-collecting `unitType`/`areaSqm` (no silent data loss) | 4 (in C5) | eng |
| 11 | **N15** — `CAMPAIGN_SEND_ENABLED` kill-switch (1-line) | 0 | eng |
| 12 | **Ops** — ClamAV host + EICAR · PII keys staging/prod · `DOC_ENCRYPTION_KEY` staging/prod · `ALERT_WEBHOOK_URL` + boot assertion (N14 fails-open today) · P0.4 magic-byte (in flight on this branch — track to merge) | deploy | 🔒owner-deploy |
| 13 | **Wave-5 external MVP (X1–X4) + DOM-PKG** — the owner's "send the bureaucracy" headline; a first customer who must hand the שמאי/עו"ד the package needs it. **Blocker, Wave-5, gated on FLOW-1.** | 5 | 🔒owner(scope) — confirm in/out of v1 |

**Post-MVP (sequenced-out, not dropped):** B3 autonomy worker (honest M2 ships first; B3 unlocks "keeps
nudging" — owner call if autonomy is a launch requirement) · C12b fuller set · C17 bulk+saved-views (needed
at ~200 projects) · C10/C11 · N13 withdrawn · N17 LISTEN/NOTIFY · the tab merger · forecast · the entire
**Wave 6 AI wave** (DPA-gated) · DOM-1/3/4/5/6 · estate-POA workflow · per-owner deal-terms.

---

## 6. THE OWNER / LEGAL STOP-POINTS (the 🔒 go/no-go list)

| Slice/topic | Gate | The decision |
|---|---|---|
| **B0** | 🔒 LEGAL OD-1/OD-3 | Exact statutory % (66 vs 67, pre-2023 80% grandfathering) + partial-share counting + SHELL-owner denominator. **Ships behind A.1 label; build NOT blocked.** |
| **OD-7 (new, v7)** | 🔒 LEGAL | Is OTP-to-phone a legally sufficient תמ"א signature, or is national_id challenge / ID upload / notary co-sign required? Ship the engine behind it. |
| **B3** | 🔒 owner-infra | Approve the new recurring worker consumer (autonomy copy stays off until then). Blocker only if autonomy is a launch requirement. |
| **B2** | 🔒 Gate-6 | Approve `decline_reason` + `'declined'` (+ optional `withdrawn` N13) migration. |
| **C1** | 🔒 owner-artifact | Print stylesheet vs server PDF. Go-live blocker. |
| **C12b / C16** | 🔒 owner-scope | Confirm the recovery + DSAR/RTBF subsets as go-live blockers; the rest sequenced after. |
| **N11** | 🔒 owner-decision | Labeled manual-entry now vs build the נסח parser. Honesty gate. |
| **C10 / C11** | 🔒 owner-scope | Discovery FE / populated calendar in v1 or post-MVP. |
| **Wave-0 doctrine** | 🔒 owner-stance | OD-5 (`en` real?), no-session-countdown UX, PII-egress cue, G-MOTION-PERF. |
| **Wave 5 (X1–X5)** | 🔒 owner/legal | External MVP in v1? token-audience split (`emapp-share` vs `emapp-exchange`), OTP channel, package-completeness "שליחה חלקית" rule, the system/exchange actor model, watermark legal text. |
| **Wave 6 AI** | 🔒 owner/DPA | DPA + zero-retention/no-train Gemini posture, per-org token budget, `ai_extraction_enabled` per org. **Removing AI is the same config flip in reverse.** |
| **Ops** | 🔒 owner-deploy | ClamAV host + EICAR · PII keys staging/prod · DOC key staging/prod · `ALERT_WEBHOOK_URL` + boot assertion. |

---

## 7. THE DOCUMENTATION / LEDGER CONVENTION ("עם תיעודים") — how each slice is documented as it's built

The owner asked to run autonomously **with full documentation**. The convention reuses the proven
`V12-SLICE-LEDGER.md` + `docs/heartbeats/` patterns already in the repo (verified present). Four artifacts:

### 7.1 The running BUILD-LEDGER — `docs/E2-SLICE-LEDGER.md` (new, models V12-SLICE-LEDGER)
One section per slice; **a slice may NOT be marked merged until every gate is ✅ with evidence.** The gate
row (identical to V12's discipline, extended for E2):

| Gate | Meaning |
|---|---|
| **Spec** | links the slice's source doc + this plan's row |
| **Reproduce (RED)** | a failing test that proves the gap before the fix (where applicable) |
| **Build** | typecheck 0 + lint clean across touched packages |
| **IndepTests (GREEN)** | the slice's tests + the relevant guard specs all green |
| **Code-review (D.51)** | review statement in the PR |
| **Security-review** | MANDATORY for PII/auth/RLS/external-write slices (S0-SEC, B0, B4, C12b, C16, X3, AI-FND); the `@security-reviewer` verdict |
| **Browser QA (4-axis)** | real-Chrome Network/URL/Cookies/Redirect **per affected role** — NOT deferred |
| **Perf** | warm-200ms + the seeded-50 gate where the slice touches the hot aggregations |
| **North-Star** | reduces actions / plain Hebrew / no fabrication / re-skinnable |
| **CI green** | full pipeline |
| **Merge-on-green** | autonomous merge incl. migration |
| **Critic** | open notes / known follow-ups |
| **Memory** | the memory file updated if a new pattern emerged |

### 7.2 The per-slice SPEC entry (write BEFORE building) — inside the ledger section
A self-contained block: **what · why · the real files/endpoints · the tests (RED first) · the verification
plan (which roles get the 4-axis walk) · the PR link · the source-doc citation.** This is the durable
"why this exists" record — exactly what V12 Slice-1 did.

### 7.3 The heartbeat / PROGRESS convention (existing, append-only)
Per the AUTOPILOT PROTOCOL in root CLAUDE.md: write bullets to
`docs/heartbeats/track-<track>/<today>.md` (NEVER inside the BEGIN/END AGENT HEARTBEATS block), run
`pnpm gen:progress`, commit BOTH the heartbeat file AND the regenerated `PROGRESS.md` in one commit.
E2 adds a **track-e** (or reuses an existing track) under the same ownership-by-directory rule; cross-track
writes remain forbidden.

### 7.4 The per-slice DoD EVIDENCE (attached to the PR, not just asserted)
Every PR body carries: the green-gate output (typecheck/lint/test), the **per-role 4-axis Chrome
evidence** (the V11 G4 standard — screenshots/network logs, never hand-waved — carry the
`feedback_visual_smoke_gap` memory: smoke is "as a user," open files / render PDFs / read email payloads),
the perf-budget number where applicable, and the security-review verdict for sensitive slices. The
universal DoD (§2.5) is the checklist; the PR is the evidence locker.

### 7.5 Decisions & memory
New cross-cutting decisions land in `docs/DECISIONS.html` (D-numbered, e.g. OD-7 signer-identity); new
durable lessons land as a memory file (the existing `project_*`/`feedback_*` convention). The plan's own
corrections (e.g. MUST-RESOLVE #1) are recorded in the ledger's preamble so the false "PR #413" claim
cannot silently re-enter.

---

## 8. VERDICT — go / no-go for the autonomous run

**`READY-TO-RUN-AUTONOMOUSLY, AFTER THREE MUST-RESOLVE ITEMS ARE ACKNOWLEDGED IN THE LEDGER.`**

The planning body is **coherent and the spine is sound**: every CRITICAL/feasibility claim the run depends
on was re-verified in real code and holds (B0 binary-by-heads, B5 no-version-predicate, the 3-consumer
scheduler, the 8 notification kinds, the extraction Stub, the missing documents parenting, the actor_type
CHECK, the existing cache provider — §0 V1–V8). All 38 design gaps + 17 production gaps + the 14 v7
should-exist gaps have a concrete, sequenced home. The v5/v6/v7 additions are genuinely additive layers on
named v4 slices, de-duplicated here (§1) so nothing is built twice. The wave order (§3) preserves the two
hard ordering laws (S0-SEC first, PERF before B0) and keeps Waves 5–6 off the critical path.

**The must-resolve items (the only things between here and "go"):**
1. **The "ConfirmDialog/M0b shipped as PR #413" claim is FALSE on the tree (§0 V9):** no ConfirmDialog or
   toast in `components/ui/`, 13 live `window.confirm`, work stranded on `fix/styled-confirm-dialog`. M0b +
   M0+G6 are a hard **Wave-0 precondition**, not a completed item — every confirm/undo in Waves 2–5 depends
   on them. The plan's coverage tables must stop citing PR #413 as done.
2. **The v3-roadmap "zero schedulers / NET-NEW infra" framing for B3 is factually wrong (§0 V3)** and is
   superseded by v4's re-scope (a 4th consumer). Execute v4's B3, not v3's — they are NOT both live; v4 is
   the spine.
3. **The Wave-5 external MVP (X1–X4) + DOM-PKG is a blocker-class owner-scope decision that is NOT yet
   made.** It is the owner's headline ("send the bureaucracy") and a first customer who must hand the
   שמאי/עו"ד the package cannot ship without it — but it is currently filed both as a go-live blocker (v7
   §4.5) and as Wave-5/post-Wave-0. The owner must explicitly place it in or out of v1 before the run, or
   the autonomous build will reach the end of Wave 4 "production-ready" while the JOB is incomplete.

Resolve those three (one is a code-truth correction, two are explicit owner-scope confirmations), and the
plan is precise enough to execute end-to-end with surprise risk near zero — the remaining open questions
are all external/legal, each shipping behind an interim-safe rule (A.1) or an explicit 🔒 gate rather than
a mid-build discovery.
