# 00 — FINAL VERIFICATION (the v8 go/no-go gate)

> **Status:** DEFINITIVE final-verification artifact — the single front-of-house go/no-go the
> owner reads before approving a fully autonomous build of the E2 production redesign over the
> entire 7-pass planning body. READ-ONLY; no app code changed. Author: v8 verification lead,
> 2026-06-18.
>
> **What this consolidates:** the three v8 fronts —
> `01-completeness-crosscheck.md` (did anything fall *between* the seven passes?),
> `02-precision-execution-readiness.md` (is every slice buildable WITHOUT mid-build
> clarification?), and `03-consolidated-master-plan.md` (the single dependency-ordered plan
> the run follows + the documentation convention). Every load-bearing feasibility claim was
> **independently re-grounded against the real tree by this lead** (see §1), not inherited.

---

## 0. THE VERDICT

**`GO — AFTER three doc-only must-resolve items are acknowledged in the ledger, with 9 owner/legal
STOP-points treated as hard pauses and 11 NEEDS-DETAIL contracts pinned at wave entry.`**

The seven-pass planning body is **coherent**, the spine (v4 FINAL-BUILD-PLAN: 41 slices, 4
CRITICAL, N1–N17) is **sound**, and the consolidated plan at
`03-consolidated-master-plan.md` is the single execution-ready artifact the run follows. The
gate's payoff is that **every CRITICAL/feasibility claim the autonomous run depends on holds
in real code** — I re-verified 9 of them this pass and all hold — **except one mis-statement**
(the "ConfirmDialog already shipped as PR #413" claim), which is false on the tree and is
promoted to a Wave-0 build precondition. That single correction, plus two owner-scope
confirmations, is the entire distance between here and an unconditional GO.

There is **no missing-screen / missing-route / missing-rule class of surprise left** — that was
the v3/v4/v7 job and it is exhaustively done. The residual risk is not scope discovery; it is
(a) a handful of LATER-pass additions never folded into the v4 tables (orphans, all bounded and
homed by the consolidation), (b) cross-doc contradictions (all doc-only, reconciled), and
(c) a small enumerated set of legal/ops DECISIONS that are scheduled gates — never mid-build
discoveries.

---

## 1. INDEPENDENT CODE RE-GROUNDING (this lead's own verification, not inherited)

I re-ran every load-bearing `file:line` anchor against the working tree. Results:

| # | Claim the run depends on | Code reality (re-verified this pass) | Verdict |
|---|---|---|---|
| 1 | **ConfirmDialog/toast NOT in the tree; "PR #413 shipped" is false** | `components/ui/` = button · list-page-shell · list-skeleton · name-display · status-badge — **no confirm-dialog, no toast/live-region**. `find apps/web/src -iname '*confirm*'` → empty. Branch `fix/styled-confirm-dialog` exists local+remote but is unmerged. **13** live `window.confirm` (not 17). | ❌ **MUST-RESOLVE #1 confirmed** |
| 2 | `actor_type` CHECK = `('user','system','provider')` | `artifacts.ts:297–299` `audit_log_actor_type_valid … IN ('user','system','provider')` | ✅ TRUE — both `+'ai'` (v6) and `+'external'` (v7) are real migrations against ONE CHECK (C-2) |
| 3 | consent calc is binary by-heads, shares stored-but-unread | `projects.service.ts:419–421` `consentedPct = apartmentsConsented/totalApartments`; `metThreshold = consentedPct >= targetSignaturePct`. No `share_numerator` in the calc. | ✅ TRUE — B0 is the real, most-dangerous defect |
| 4 | `projects.update()` any→any + no version predicate | `:773` `if (input.status !== undefined) patch.status = input.status;` (unconditional); `:803` `tx.update(projects).set(patch).where(eq(projects.id, id))` — **no `updated_at`/version clause** | ✅ TRUE — B5's two halves both real and unbuilt |
| 5 | scheduler ALREADY runs 3 cron sweeps | `apps/worker/src/main.ts` `boss.schedule(REAPER…:245)`, `(AUDIT_RETENTION…:274)`, `(SIGNATURE_EXPIRY…:309)` on `registerHandler→boss.schedule` | ✅ TRUE — B3 = "add a 4th consumer," NOT "build a scheduler"; v2/v3 "zero schedulers" premise is **factually wrong** (C-1) |
| 6 | notification.ts has exactly 8 kinds, none of expiring/stalled/threshold | `notification.ts:12–22` 8 kinds (`task_assigned`…`message_received`); grep for `expiring\|stalled\|threshold_reached` = **0** | ✅ TRUE — B3 must add 3 kinds + link targets |
| 7 | tabu extraction runs on a deterministic Stub | `tabu/extraction-provider.factory.ts:36` `return new StubExtractionProvider();`; gemini branch commented `:34` | ✅ TRUE — N11 honesty gate is real |
| 8 | `documents` has no `owner_id`/`building_id` parenting | `artifacts.ts:30–31` only `project_id` + `apartment_id` nullable FKs | ✅ TRUE — FLOW-0 additive migration net-new |
| 9 | DSAR/RTBF routes exist, no UI; member-overrides PUT/DELETE exist; renter is a dead no-op; cache provider exists; kill-switch absent | `owners.controller.ts:128 @Get(':id/data-export')` + `:139 @Post(':id/erase')`; `member-overrides.controller.ts @Put:47/@Delete:57`; `ownership.ts:23 RelationshipSchema=z.enum(['owner'])`; `providers/cache/{postgres,fake}.provider.ts` present; `grep CAMPAIGN_SEND_ENABLED` = 0 | ✅ ALL TRUE — C16 is UI-only, C10/G10 renter migration real, PERF is wiring, N15 net-new |

**Net:** the plan's `file:line` precision is real and trustworthy on the *defects*. The only
false claim is on a *remedy already in flight* (ConfirmDialog) — a stale-inventory error, not a
design error. The gate holds.

---

## 2. DID WE COVER EVERYTHING? (the completeness conclusion)

**YES over the engine AND the job — with full traceability.** Every numbered/lettered item
across all seven passes maps to a concrete, sequenced home in the consolidated plan:

- **v2 (5 locked decisions + doctrine binding rules)** → all COVERED (Wave 0 + B0 + E2 + A.1–A.3 DoD).
- **v3 (38 design gaps A1–A9 · B1–B12 · C-a..C-l)** → all 38 carry a home (`v4 §D:208–213`).
- **v4 (17 production gaps N1–N17)** → all 17 homed (`v4 §D:215–219`).
- **v7 (14 should-exist gaps G1–G14)** → all homed; the two-sided document-FLOW method closes
  the one structural blind spot the route-maps had (FLOW-0..4 · X1–X5 · DOM).
- **Security P0/P1/P2 program** → P0 into S0-SEC + ops; P1/P2 into natural slices + an
  eng-hardening mini-wave; ops gates in the go-live blocker set.
- **v5/v6 creative + AI layers** → ride existing slices (de-duplicated in `03 §1`: the A2 ranker
  IS v6's RuleDecisionProvider; W2 IS the action_queue; one build each).

**The evidence of completeness** is the master traceability table in `01 §1` (every row has a
named home) plus the de-duplication map in `03 §1` (every "same work under two names" collapsed
to one slice). There is **no missing-route / missing-screen / missing-rule surprise** remaining.

The one reservation: the **v4 FINAL-BUILD-PLAN was frozen BEFORE v5/v6/v7 folded their additions
into its own §D/§E tables**, so a run reading *only v4* would silently drop the LATER-pass
additions. That is exactly why the consolidation (`03`) exists and is the artifact the run
follows — not raw v4.

---

## 3. ORPHANS & CONTRADICTIONS — with resolutions (all closed in the consolidated plan)

### 3.1 Orphans (raised in a later pass, never folded into v4's tables) — all now homed in `03 §4`

| # | Orphan | Resolution (now in the consolidated plan) |
|---|---|---|
| **O-1** | A1 reminder-memory (`reminder_count`+`last_reminded_at`) — code-confirmed absent | Named slice **A1** in Wave 3, ordered **before B3** (cadence depends on it). One additive Gate-6 migration. |
| **O-2** | A3 "while you were away" digest (+`last_seen_at`) | Named **A3-digest** after B3 (deterministic first; AI polish in Wave 6). NEEDS-DETAIL: pin the last-seen source. |
| **O-3** | W4 / A6 composite `POST /projects/build-from-parcel` — the headline first-session wow | Named slice **W4** wrapping `parcel-setups.controller.ts:81`. READY. |
| **O-4** | W2 `GET /org/automation-plan` Action-Queue read (overlaps v6 `action_queue`) | Merged with v6 PROPOSE into **AI-FND-3** `action_queue` (build once). |
| **O-5** | Two-track rule + 6 AI-safety rules missing from the universal DoD | Folded verbatim into **`03 §2.3` + §2.4** of the consolidated plan's universal DoD. Doc-only, load-bearing. |
| **O-6** | The deterministic AI-foundation slice (`IAiProvider`/`IDecisionProvider`/`CircuitBreaker`/`PiiRedactor`) | Named **Wave 3.5 (AI-FND-1/2/3)** — deterministic, zero-LLM, non-blocking on Wave 0. |
| **O-7** | The dedicated owner/DPA-gated AI wave (Gemini use-cases) | Named **Wave 6**, explicitly flagged not-in-autonomous-scope until the DPA decision. |
| **O-8** | G7 viewed-but-not-signed (v7's own "not yet homed") | **OWNER scope decision**: a `signature_requests.viewed` micro-slice near B2, OR explicit post-MVP defer. Listed as a must-detail/owner item — do not leave floating. |

### 3.2 Contradictions (docs disagree on a fact/scope) — all reconciled

| # | Contradiction | Resolution |
|---|---|---|
| **C-1** | "Zero schedulers exist today" (v2/v3) vs "3 live sweeps" (v4/v5/v6/v7) | **v2/v3 premise is factually WRONG** (code-verified, §1.5). Reconcile prose to "the scheduler EXISTS; it does not yet CHASE — B3 adds the chase, not the scheduler." The *guardrail* (no "system chased" copy until B3 emits notifications) stays valid for the right reason: the sweeps emit ZERO notifications (8 kinds, none of expiring/stalled). |
| **C-2** | THREE passes independently widen the ONE `actor_type` CHECK (`'provider'`→`+'ai'` v6, `+'external'` v7) — code-confirmed collision at `artifacts.ts:299` | **ONE migration** widens to `IN ('user','system','provider','external','ai')` (or two ordered, mutually-aware). Assign to whichever of X5 / AI-FND-3 lands first; the other consumes it. Carry the schema-constraint-ripple caution (every raw-SQL audit INSERT). |
| **C-3** | C1 committee print: REBUILD (v4) vs PARTIAL (v5) | **Adopt v5's downgrade**: C1 reuses `pdf-signed-document.renderer.ts` with a new template, NOT a from-scratch renderer. Still a go-live blocker; lower risk. |
| **C-4** | AV-scan "does not exist" (stale v4 long-flows front) vs EXISTS (code: `scan_status` + `IFileScanProvider`) | **No build action** — already correct in the FINAL-BUILD-PLAN. Documentation-hygiene only: **no slice may "add AV scanning"** — it is wired fail-closed. |

**Consistency checks that PASSED (no contradiction):** v4↔v7 on B0 (agree exactly); v4↔v7 on
the 4-CRITICAL order (v7 slots its work as Wave 5, not a Wave-0 delay); v6 dual-mode ↔ v5
action-queue (reconcile cleanly — the only seam is naming); v6↔v5 on B3 ("add a 4th handler").

---

## 4. PRECISION — is it buildable autonomously without mid-build clarification?

**YES — `precise-enough-to-run-autonomously`.** ~30 of 41 v4 slices are READY as written, every
CRITICAL slice (S0-SEC, B5, B0, B3) names the exact `file:line` it edits, and the four certainty
gates are genuinely buildable. The Wave-5 FLOW/X spine is READY at the *table/route* level and
NEEDS-DETAIL only at the *domain-catalogue* level.

### 4.1 The 11 NEEDS-DETAIL contracts (pin at WAVE ENTRY, not mid-build)

These have a real spine but a contract an agent would otherwise **guess** (guessing → silent
rework, worse than a build failure):

1. **PERF** — cache-key shape + exact invalidation write-set + the seeded-50 pass-threshold.
   **Highest priority: it gates B0.**
2. **A2 / B1.rankAttention()** — the ranking formula/weights are undefined; B1 ships a row but
   not an order, and **the entire mission-control home (E2.1) renders off that order.** Pin with B1.
3. **FLOW-1 template content + FLOW-2 matching rule** — the per-entity required-docs catalogue
   (domain IP) + the doc_type-compatibility/auto-confirm matcher are the **Wave-5 keystone**, and
   X4 inherits the template decision. Described, not pinned.
4. **E2.0-GUARD** — the true full-tree leak baseline (incl. provider subtree) must be *measured*
   before the ratchet starts, else it begins from a false floor.
5. **M0+G6** — enumerate the ~11 bespoke "saved" sites; reconcile with the ConfirmDialog branch.
6. **A3 digest** — pick the `last_seen_at` source (new column vs session last-activity).
7. **C5 / N16** — persist-vs-drop `unitType`/`areaSqm` is a fork (persist ⇒ migration). Pin it.
8. **C17** — the bulk-verb partial-failure envelope + max-batch + saved-view persistence model.
9. **M6 / C-f** — owner-PII-reveal gate parity decision.
10. **C-c** — the milestone-overlay is one undecided line, not a spec.
11. **C-d ↔ C16 overlap** — de-conflict who owns the member-overrides surface.

Plus the **two DRIFT re-baselines** (mechanical, Wave-0 entry): ConfirmDialog = land-the-branch
(`fix/styled-confirm-dialog`), not build-from-scratch; `window.confirm` 17→**13** (re-confirmed).

### 4.2 The structural build-process risk (beyond slices): cross-slice de-confliction

Under parallel autonomous agents the residual risk is concurrency, not scope:
- **Shared-primitive contention** — M0+G6 + ConfirmDialog gate M2/M5/C2 + most of Wave 4.
  **Enforce a hard "primitives-frozen" gate at end of Wave 0.**
- **Surface overlap** — C-d↔C16, C16↔C10, M5↔A4, E2-list↔C17. **Assign each overlapping surface
  a single owning slice at wave entry** so two agents don't clobber the same file.
- **CHECK-widen migration ripple** (B2, FLOW-3, A1, X5 audit-actor) — **make "scan all raw
  seeders" a DoD line on EVERY migration slice**, not just B2.

---

## 5. THE OWNER / LEGAL STOP-POINTS (where the run MUST pause — all DECISIONS, never discoveries)

The plan's decisive property: **every gate below is a scheduled DECISION reachable behind an
interim-safe rule** (the A.1 consent-basis label, the A.2 DO-NOT-FABRICATE register, the
ship-the-stub-honestly gates), so the build continues productively up to each gate rather than
blocking on it.

| # | STOP-point | Slice(s) | The decision | Build proceeds behind it? |
|---|---|---|---|---|
| 1 | **Statutory consent %** (OD-1/OD-3) | B0 | Exact % (66/67/pre-2023 80% grandfathering) + partial-share counting + SHELL-owner denominator. **LEGAL.** | ✅ YES — D.1 locks share-weighted; ships behind the A.1 basis-label. STOP is the legal % only. |
| 2 | **Gate-6 migrations** | A1, B2, FLOW-3, AI-FND-3, X5, FLOW-0/1, X1 | Schema-migration approval (each adds a column / widens a CHECK). | ⚠️ Engineering ready; migration can't run unapproved. |
| 3 | **`withdrawn` (N13) MVP scope** | B2 | Is post-signature withdrawal in MVP? **OWNER/LEGAL.** | ✅ YES — `declined` ships without it. |
| 4 | **Recurring-consumer approval** | B3 | Approve a recurring autonomous worker. **OWNER (infra).** | ✅ YES for everything else; autonomy *copy* stays off until approved. Blocker only if autonomy is a launch requirement. |
| 5 | **C1 print vs server-PDF** | C1, DOM-PKG | Print stylesheet vs audited server-rendered PDF. **OWNER (artifact).** Go-live blocker. | ❌ NO — the fork changes whether C1 is FE-only or net-new BE. Decide first. |
| 6 | **C12b / C16 go-live subset** | C12b, C16 | Confirm MFA-reset/unlock/resend (C12b) + DSAR/RTBF (C16) as the go-live subset; rest post-MVP. **OWNER (scope).** | ✅ YES for the subset (the blocker). |
| 7 | **N11 tabu honesty** | N11 | Labeled manual-entry NOW vs build the real נסח parser. **OWNER.** Honesty gate. | ⚠️ The honest manual-entry path ships; shipping "extraction" over the stub is FORBIDDEN. |
| 8 | **C10 / C11 / DOM-1/3/4/5/6 E2-vs-post-MVP** | C10, C11, DOM-* | In E2 scope or post-MVP? **OWNER (scope).** | ✅ YES — sequenced-out by default; STOP only fires if owner pulls them in. |
| 9 | **External-exchange legal/ops** | X3, X5 | (X3) `@security-reviewer` mandatory pre-commit — INTERNAL, fail-closed. (X5) watermark legal text + OTP channel (SMS/email) + `EXCHANGE_TOKEN_SECRET` split (new boot env). **OWNER/LEGAL + OPS.** | ⚠️ X1/X2/X4 build behind these; X3 can't commit without the review; X5 can't ship without the owner/ops calls. |
| + | **OD-7 signer-identity sufficiency** (v7) | the whole signing engine | Is OTP-to-phone a legally sufficient תמ"א signature, or is national_id challenge / ID-upload / notary co-sign required? **LEGAL.** | ✅ YES — ship the engine behind the gate. |
| + | **Deploy-time secrets (OPS)** | cross-cutting | ClamAV host + EICAR · PII keys staging/prod · `DOC_ENCRYPTION_KEY` staging/prod · `ALERT_WEBHOOK_URL` + boot assertion (N14 fails-open today) · P0.4 magic-byte (in flight). **OWNER-DEPLOY.** | ✅ Build proceeds; these are go-live gates — but MUST be tracked or alerting/PII/encryption silently no-op in prod. |
| + | **Wave 6 AI — DPA** | Gemini wave only | DPA + zero-retention/no-train posture; first real PII egress to an LLM. **OWNER/LEGAL.** | ✅ YES — the entire deterministic foundation (Wave 3.5) builds without it; only the GeminiProvider wave pauses. Removing AI is the same config flip in reverse. |

---

## 6. THE THREE MUST-RESOLVE ITEMS BEFORE "GO" (the whole distance to unconditional approval)

1. **CODE-TRUTH: the "ConfirmDialog/M0b shipped as PR #413" claim is FALSE on the tree** (§1.1).
   No ConfirmDialog/toast in `components/ui/`, 13 live `window.confirm`, work stranded on
   `fix/styled-confirm-dialog`. **M0b (land the branch) + M0+G6 (live-region) are a hard Wave-0
   PRECONDITION**, not a done item — every confirm/undo in Waves 2–5 depends on them. The coverage
   tables must stop citing PR #413 as done. *(Already corrected in `03 §0 V9`.)*
2. **OWNER-SCOPE: execute B3 as v4's re-scope, not v3's.** The v3-roadmap "zero schedulers /
   NET-NEW infra" framing is factually wrong (§1.5); B3 is a 4th pg-boss consumer. They are not
   both live — v4 (the consolidation) is the spine.
3. **OWNER-SCOPE: place the Wave-5 external MVP (X1–X4 + DOM-PKG) explicitly in or out of v1.**
   It is the owner's headline "send the bureaucracy" ask, filed simultaneously as a go-live
   blocker AND as off-critical-path. Without an explicit call, the build reaches end-of-Wave-4
   "production-ready" while the urban-renewal JOB (hand the שמאי/עו"ד the package) is still
   incomplete. Also make the explicit call on **O-8 (G7 viewed-but-not-signed)**: in near B2 or
   deferred — do not leave it floating.

---

## 7. THE SINGLE CONSOLIDATED EXECUTION-READY PLAN

The run follows **`docs/design-research/v8-final-verification/03-consolidated-master-plan.md`** —
NOT raw v4. It is the de-duplicated merge of all seven passes, dependency-ordered:

```
WAVE 0   Foundation + security/perf/primitive gate   (S0-SEC ⭐ → PERF ⭐ → land ConfirmDialog → live-region → tokens/guards/tz/DataState)
WAVE 1   Structural + consent + integrity            (B0 ⭐ + B5 ⭐ = the certainty gate · board-first · sidebar 14→5 + S4 · auth re-skin)
WAVE 2   Backend-gated surfaces                       (B1 pulse +A2/A5/A8 · B4 holdout · home · board · M2 chase · list)
WAVE 3   The "movie" + honest autonomy               (A1 reminder-memory → M3 wow · B3 ⭐ · M5 campaign+preview+failed · B2 why-layer)
WAVE 3.5 AI-ready foundation (deterministic, 0-LLM)   (IAiProvider+Noop · IDecisionProvider=A2 · action_queue+autonomy · actorType:'ai')
WAVE 4   Completeness + operator control              (C1 ⭐ · C12b ⭐ · C16 · C5 · C8 · C7 · C14 · C15 · C12 · C17 · N11 · C10 · C11 · M6 · ∥ eng-harden)
WAVE 5   Document-FLOW + external exchange (v7)        (FLOW-0→4 · X1→X5 · DOM-PKG · DOM-1/2 · renter axis)
WAVE 6   The AI wave (owner/DPA-gated)                (Gemini providers · extraction #1 · draft #2 · digest #3)
```

**Two hard ordering laws (never reorder):** (1) **S0-SEC lands FIRST** (every new BE surface
validated by construction, N12); (2) **PERF lands before B0** (the heavier share-weighted CTE
proven sub-second at 50 projects, N9). Waves 5–6 depend only on Wave 0 and never preempt the
go-live-blocker set in Waves 0–4.

---

## 8. THE DOCUMENTATION / LEDGER CONVENTION ("עם תיעודים")

The run documents itself via the proven repo patterns (`V12-SLICE-LEDGER.md` +
`docs/heartbeats/`, both verified present), per `03 §7`:

1. **Running BUILD-LEDGER** — `docs/E2-SLICE-LEDGER.md` (new, models V12). One section per slice;
   **a slice may NOT be marked merged until every gate row is ✅ with evidence**: Spec · Reproduce
   (RED) · Build · IndepTests (GREEN) · Code-review (D.51) · **Security-review (mandatory for
   PII/auth/RLS/external-write: S0-SEC, B0, B4, C12b, C16, X3, AI-FND)** · Browser QA (4-axis,
   per role, NOT deferred) · Perf (warm-200ms + seeded-50 where it touches the hot aggregations) ·
   North-Star · CI green · Merge-on-green · Critic · Memory.
2. **Per-slice SPEC entry (write BEFORE building)** — what · why · real files/endpoints · tests
   (RED first) · which roles get the 4-axis walk · PR link · source-doc citation.
3. **Heartbeats** — append-only to `docs/heartbeats/track-<track>/<today>.md` (NEVER inside the
   BEGIN/END block), then `pnpm gen:progress`, commit heartbeat + regenerated `PROGRESS.md`
   together. Cross-track writes forbidden (directory naming IS ownership).
4. **PR = the evidence locker** — green-gate output, per-role 4-axis Chrome evidence (the V11 G4
   standard; smoke is "as a user" — open files, render PDFs, read email payloads), perf number,
   security-review verdict.
5. **Decisions & memory** — cross-cutting decisions → `docs/DECISIONS.html` (D-numbered, e.g.
   OD-7); durable lessons → memory files. The MUST-RESOLVE corrections (esp. the false PR #413)
   are recorded in the ledger preamble so they cannot silently re-enter.

---

## 9. BOTTOM LINE FOR THE OWNER

You can greenlight the autonomous run. The plan covers everything (every v2/v3/v4/v7 gap +
the full security program has a named, sequenced home), it is precise enough to build without
mid-build guessing (every CRITICAL slice's `file:line` re-verified and holding), and it
documents itself slice-by-slice. **Before the run starts, acknowledge in the ledger:** (1) the
ConfirmDialog work is NOT done — it is a Wave-0 precondition; (2) B3 is v4's "4th consumer," not
v3's "build a scheduler"; (3) your in/out call on the Wave-5 external-exchange MVP (and on the
small G7 viewed-state). The run will **pause and ask you** only at the enumerated gates — the
legal consent %, the C1 print-vs-PDF artifact, the N11 tabu-honesty path, each Gate-6 migration,
the B3 infra approval, the C12b/C16 go-live subsets, the C10/C11 scope, the X3/X5 external
security+legal gates, the deploy secrets, and the Wave-6 DPA — each reachable behind an
interim-safe rule, never as a mid-build surprise.
