# 01 — COMPLETENESS CROSS-CHECK (the v8 final-verification front)

> **Status:** DEFINITIVE v8 verification artifact — the completeness front of the final
> go/no-go gate before the autonomous build. READ-ONLY; no app code changed. Author:
> v8 completeness-crosscheck seat, 2026-06-18.
>
> **My front (the question I answer):** did anything fall *between* the seven planning
> passes? I gathered the COMPLETE set of items raised across all passes — v2 (5 locked
> decisions + doctrine binding rules), v3 (38 design gaps), v4 (17 production gaps N1–N17),
> v5 (8 creative additions A1–A8 + W-items + 5 primitives + the two-track rule), v6 (the
> AI-foundation items + dual-mode + safety contract), v7 (14 should-exist gaps G1–G14 +
> FLOW/X/DOM slices), and the SECURITY-POSTURE P0/P1/P2 program — and verified, for EACH,
> that it has a concrete HOME in the consolidated plan (v4 FINAL-BUILD-PLAN + v7 Wave 5 +
> v5/v6 additions). I then hunted ORPHANS (raised once, never folded in) and CONTRADICTIONS
> (docs that disagree on a fact or a scope). Load-bearing feasibility claims were
> re-grounded against real code.
>
> **Method note — what I re-verified directly in code** (not inherited):
> `apps/worker/src/main.ts` (scheduler), `packages/shared-types/src/notification.ts`
> (notification kinds), `packages/db/src/schema/artifacts.ts` (`actor_type` CHECK + `scan_status`).

---

## 0. VERDICT (my front)

**`COVERED-WITH-RESERVATIONS — GO, conditional on resolving 5 ORPHANS + 4 CONTRADICTIONS first.`**

Every numbered/lettered item across all seven passes maps to a concrete, sequenced home —
the traceability is genuinely exhaustive over the **engine** (v2/v3/v4) and the **job**
(v7), and the creative/AI layers (v5/v6) ride existing slices rather than bolting on. The
plan does NOT have a coverage hole that will surface a *missing screen* mid-build. But the
consolidation was authored by **multiple seats across seven passes**, and a handful of
items raised in a LATER pass were never folded back into the v4 FINAL-BUILD-PLAN (which
predates v5/v6/v7 content folding into its own §D/§E tables). Those are the orphans. And
four cross-doc factual/scope contradictions remain live — most importantly a **single
`actor_type` CHECK that THREE separate passes each independently "widen" without knowing
about each other.** None is a design error; all are reconcile-before-autonomy items so the
autonomous run does not author three conflicting migrations or skip a creative addition that
was approved but never sequenced.

---

## 1. MASTER TRACEABILITY TABLE

Status legend: **COVERED** = a concrete, named home in the build plan (v4 §D/§E, v7 §4.2/§4.3,
or an explicit slice). **ORPHAN** = raised in some pass, no home in any consolidated plan table.
**CONTRADICTION** = two docs disagree on a fact or scope that must be reconciled.

### 1.1 — v2 LOCKED DECISIONS (5) + doctrine binding rules

| Item | Source | Home | Status |
|---|---|---|---|
| D.1 Consent = share-weighted | `v2/DECISIONS-LOCKED §1` | **B0** (Wave 1) | COVERED |
| D.1 interim basis-label rule | `v2 §1` | **A.1** binding rule (every slice) | COVERED |
| D.2 Propose→one-tap now; full-auto via B3 | `v2 §2` | **M2** (now) + **B3** (later) | COVERED |
| D.2 HARD GUARDRAIL "zero scheduler today / no chased-copy" | `v2 §2` | **A.2** register | **CONTRADICTION C-1** (premise factually wrong — see §3) |
| D.3 Foundation-first + converge home onto Pattern A | `v2 §3` | **Wave 0** + **E2.1** | COVERED |
| D.4 Sidebar 14→5 + global search SAME wave; merger deferred | `v2 §4` | **E2-IA-S2** + **S4** (same wave) | COVERED |
| D.5 Brand = navy `#0b2545` | `v2 §5` | **E2.0** (one-token edit) | COVERED |
| Doctrine: system-does-the-work / minimal-action / dual-mode | `DESIGN-NORTH-STAR` | **A.3** North-Star DoD check + v6 | COVERED |
| Doctrine: DO-NOT-FABRICATE | `DESIGN-NORTH-STAR` | **A.2** register | COVERED |

### 1.2 — v3 DESIGN GAPS (38: A1–A9, B1–B12, C-a..C-l)

Confirmed against the v4 §D coverage line (`00-FINAL-BUILD-PLAN.md:208–213`). All 38 carry a home:

| Gap(s) | Home | Status |
|---|---|---|
| A1·A2 | B0 | COVERED |
| A3 | B5 | COVERED |
| A4 | B4 | COVERED |
| A5·A6 | B1 | COVERED |
| A7 | **M0b (PR #413)** | COVERED — shipped; not re-counted in the 41 |
| A8·A9 | E2.0-GUARD + C12 | COVERED |
| B1 | C13 | COVERED |
| B2 | M0+G6 | COVERED |
| B3 | B2 ripple | COVERED |
| B4 | C1 | COVERED |
| B5 | B0 | COVERED |
| B6 | M2 | COVERED |
| B7 | C14 | COVERED |
| B8 | C7 | COVERED |
| B9 | C15 | COVERED |
| B10 | S0-SEC | COVERED |
| B11 | E2.1 (Viewer route) | COVERED |
| B12 | P-TZ-1 (ICU plurals) | COVERED |
| C-a | E2.1 | COVERED |
| C-b | C8/C10 | COVERED |
| C-c | C-c (milestone overlay) | COVERED |
| C-d | C-d (override surface) | COVERED |
| C-e | C10 (renter dead-code) | COVERED |
| C-f | M6 (StepUp reconcile) | COVERED |
| C-g | E2.1 (`/org/stats` fate) | COVERED |
| C-h | C11 | COVERED |
| C-i | B3 | COVERED |
| C-j | Wave-0 doctrine + C2 | COVERED |
| C-k | M5 (agent matrix) | COVERED |
| C-l | C-l (stale counts) | COVERED |

### 1.3 — v4 PRODUCTION GAPS (17: N1–N17)

Confirmed against v4 §D (`:215–219`). All 17 homed:

| Gap | Home | Status |
|---|---|---|
| N1 | B5(ii) optimistic concurrency | COVERED |
| N2 | B5(i) state machine | COVERED |
| N3 | B3 (re-scoped) | COVERED |
| N4 | B0 (+portal denominator) | COVERED |
| N5 | C12b (recovery subset = go-live blocker) | COVERED |
| N6 | C16 (DSAR/RTBF = go-live blocker) | COVERED |
| N7 | M5 (failed-surface) | COVERED |
| N8 | M5 (preview endpoint) | COVERED |
| N9 | PERF + B0 (ConsentCalcService) | COVERED |
| N10 | C17 (+E2-list view half) | COVERED |
| N11 | N11 (tabu honesty gate) | COVERED |
| N12 | S0-SEC | COVERED |
| N13 | B2 (withdrawn) | COVERED |
| N14 | C12b (drain) + ops checklist | COVERED |
| N15 | Wave-0 (`CAMPAIGN_SEND_ENABLED`) | COVERED |
| N16 | C5 (persist-or-drop) | COVERED |
| N17 | C8 (LISTEN/NOTIFY note) | COVERED |

### 1.4 — v5 CREATIVE ADDITIONS (A1–A8) + W-items + 5 primitives + two-track rule

This is where the first orphans appear: v5 explicitly says its additions "ride existing
slices," but the v4 FINAL-BUILD-PLAN §D/§E (authored before v5) **does not name A1–A8 or
the W-items in any traceability table.** They live only in `v5-optimal/00-OPTIMAL-AND-WOW.md`.

| Item | v5 stated slot | In a consolidated plan table? | Status |
|---|---|---|---|
| **A1 — reminder-memory (`reminder_count`/`last_reminded_at`)** | "a tiny BE slice BEFORE B3" | **NO — not in v4 §D/§E; not a named slice** | **ORPHAN O-1** |
| A2 — Next-Best-Action ranker | "extend B1 with `rankAttention()`" | Implicitly inside B1; named explicitly in v6 as `RuleDecisionProvider` | COVERED (via v6 §2.1) |
| A3 — "while you were away" digest | "small BE digest endpoint after B3 + E2.1 strip" | **NO — no named slice; needs `last_seen_at`** | **ORPHAN O-2** |
| A4 — bulk-by-intent campaign | "extend M5 + C17" | M5/C17 exist; intent-scoping not spelled in either slice's scope | PARTIAL → fold into M5/C17 scope |
| A5 — anticipatory `expires_at` cards | "derived field on B1 + card on E2.1" | Inside B1 row (`nextExpiryAt` IS pinned in B1) | COVERED |
| A6 — build-from-parcel propose-and-approve | "re-frame C5; W4 composite" | C5 exists; **W4 composite wrapper not a named slice** | **ORPHAN O-3** (W4) |
| A7 — "finish this project" coach | "panel on E2.2-S3" | E2.2-S3 exists; coach panel not in its scope line | PARTIAL → fold into E2.2-S3 |
| A8 — auto-triage `needsHuman[]` | "second bucket in B1 pulse" | B1 returns `{buckets, attention}`; `needsHuman` bucket not pinned in B1's row contract | PARTIAL → fold into B1 |
| **W4 — `POST /projects/build-from-parcel` composite** | "highest wow-per-effort net-new BE" | **NO named slice anywhere** | **ORPHAN O-3** (same as A6) |
| **W2 — `GET /org/automation-plan` (Action Queue read)** | "extend B3" | Named in v6 as the PROPOSE surface (action_queue); but no FE/BE slice line | **ORPHAN O-4** (see §3) |
| Two-track rule (reversible→undo / irreversible→confirm) | "write into universal DoD (GAP-W1)" | **NOT in the v4 §A.3 universal DoD text** | **ORPHAN O-5** |
| 5 primitives (Action Queue, Explain-Chip, Undo-Toast, Calm-Home, Failure-Grace) | M0+G6 / M2 / B3 / E2.1 / C2 | Each maps to a real slice | COVERED |
| FE primitive layer missing (ConfirmDialog + live-region as Wave-0 prereq) | "harden in Wave 0" | M0+G6 (live-region) + M0b (ConfirmDialog, PR #413) | COVERED |

### 1.5 — v6 AI-FOUNDATION items + dual-mode + safety contract

v6 §7.1 is explicit that the AI-ready foundation is a **tail addition after the deterministic
loop**, does NOT touch Wave 0, and "most of it is already in the plan under different names."
But none of these named artifacts appear in the v4 §E wave/slice list:

| Item | v6 slot | In v4 §E slice list? | Status |
|---|---|---|---|
| `IAiProvider` + `NoopAiProvider` + factory | NOW (foundation) | **NO** | **ORPHAN O-6** (AI-foundation slice, see §3) |
| `IDecisionProvider` + `RuleDecisionProvider` (= A2 ranker) | NOW | Implicit in B1's ranker; not a named "AI" slice | COVERED (as A2) / PARTIAL (the seam wrapper) |
| `CircuitBreaker` + `PiiRedactor` egress scrub | NOW | **NO** | ORPHAN O-6 |
| `action_queue` table + autonomy-level config + resolver | NOW (PROPOSE surface) | **NO named slice** (overlaps v5 W2) | ORPHAN O-4/O-6 |
| `actorType:'ai'` CHECK migration | NOW | **NO** | **CONTRADICTION C-2** (collides with v7 X5 `'external'`) |
| AI safety contract (6 binding rules) → add to DoD A.3 | "add to universal DoD" | **NOT in v4 §A.3 text** | ORPHAN O-5 (same gap as two-track rule) |
| Dedicated AI wave (Gemini providers, use-cases #1–#3) | LATER (DPA-gated) | **NO wave** in v4 §E | **ORPHAN O-7** (the whole AI wave is unsequenced in the master list) |
| OD-7 signer-identity legal gate | v6 §4.4 + v7 §4.4 | Owner-gate list (v7 §4.4) | COVERED |

### 1.6 — v7 SHOULD-EXIST GAPS (G1–G14) + FLOW/X/DOM slices

v7 §4.2/§4.3 sequences these as **Wave 5** + DOM slices. All G-gaps homed:

| Gap | Home | Status |
|---|---|---|
| G1 per-entity two-sided document FLOW | FLOW-1..4 | COVERED |
| G2 share-weighted consent | B0 | COVERED |
| G3 committee print + filing package | C1 + DOM-PKG/X4 | COVERED |
| G4 secure two-way external exchange | X1–X5 | COVERED |
| G5 objection register | B2 | COVERED |
| G6 chase loop actually chasing | B3 + M2 | COVERED |
| **G7 viewed-but-not-signed state** | **"Not yet homed"** (v7 §1.5 verbatim) | **ORPHAN O-8** |
| G8 estate/POA/company/minor | DOM-1 | COVERED |
| G9 per-owner deal terms | DOM-3 (post-MVP) | COVERED |
| G10 renter axis made real | C10 (extend) + shared-types migration | COVERED |
| G11 document retention/legal-hold | DOM-2 | COVERED |
| G12 signer-identity legal sufficiency | OD-7 legal gate | COVERED |
| G13 post-approved lifecycle | DOM-4/5/6 (post-MVP) | COVERED |
| G14 cancellation reason + DSAR export-half verify | trivial / verify | COVERED |
| FLOW-0 additive `documents.{owner_id,building_id}` | FLOW-0 | COVERED |
| X1–X5 external exchange | Wave 5 | COVERED |
| DOM-PKG filing-package generator | DOM-PKG | COVERED |
| X5 `actor_type='external'` migration | X5 | **CONTRADICTION C-2** (collides with v6 `'ai'`) |

### 1.7 — SECURITY POSTURE (P0.1–P0.4, P1.1–P1.6, P2.1–P2.6, ops checklist)

| Item | Home | Status |
|---|---|---|
| P0.1 global APP_PIPE | S0-SEC | COVERED |
| P0.2 input-validation-coverage CI guard | S0-SEC | COVERED |
| P0.3 national_id checksum regression lock | S0-SEC | COVERED |
| P0.4 magic-byte + nosniff | **in flight** (this branch `fix/document-magic-byte-verification`) | COVERED — track to merge |
| P1.1 `.strict()` on List*Query | S0-SEC follow-up (Wave 0 tail) | COVERED |
| P1.2 OTP phone refine at boundary | C14 | COVERED |
| P1.3 provider ParseUUIDPipe→Zod | C12 | COVERED |
| P1.4 org-login-failure audit event | S0-SEC tail | COVERED |
| P1.5 `--prod` dep-audit · P1.6 method-level auth ratchet | eng-hardening mini-wave | COVERED |
| P2.1 array `.max()` · P2.2 per-route bodyLimit · P2.3 sign `:token` `.max()` · P2.4 doc-scan inline→worker | eng-hardening mini-wave | COVERED |
| P2.5 PII key-rotation runbook · P2.6 single risk register | owner-gated | COVERED (owner) |
| Ops: ClamAV+EICAR · PII keys staging/prod · DOC key · ALERT_WEBHOOK_URL+boot-assert | v4 §F #10 go-live blockers | COVERED |

---

## 2. THE ORPHAN LIST (raised in one pass, no home in any consolidated plan table)

These were each proposed as additive (mostly v5/v6), but the v4 FINAL-BUILD-PLAN — which is
THE artifact the autonomous run follows — predates the v5/v6/v7 content and never folded them
into its §D coverage map or §E slice list. **An autonomous run reading only the v4 plan would
silently drop them.** Each must be explicitly slotted (or explicitly deferred) before the run.

| # | Orphan | Raised in | Why it matters | Resolution |
|---|---|---|---|---|
| **O-1** | **A1 reminder-memory** (`reminder_count` + `last_reminded_at` migration + resend-path UPDATE) | v5 Tier-1 | Confirmed MISSING in code (`schema/artifacts.ts:148-162` per v5). B3's honest cadence and A2's recency-deprioritizer BOTH depend on it; without it B3 over-nudges. v5 explicitly sequences it "BEFORE B3." | **Add a named micro-slice `A1` to Wave 3, ordered before B3.** One additive migration. |
| **O-2** | **A3 "while you were away" digest** (+ `last_seen_at` per user + digest assembler endpoint) | v5 Tier-1 + v6 use-case #3 | The doctrine's single strongest "the system manages it for me" sentence; v6 makes it AI use-case #3 with a deterministic fallback. No named slice. | **Add a named slice `A3-digest` after B3** (BE digest read + E2.1 hero strip). Deterministic first; AI polish later. |
| **O-3** | **W4 / A6 composite `POST /projects/build-from-parcel`** | v5 §4 + §"first-five-minutes" | v5 calls it "the highest wow-per-effort net-new BE on the whole front" — the first-session magic moment. Wraps the existing `parcel-setups confirm`. C5 is named but is the *wizard re-skin*, NOT this composite. | **Add a named slice `W4` (BE composite) tied to C5.** Owner already has the `parcel-setups.controller.ts:81` transaction to wrap. |
| **O-4** | **W2 `GET /org/automation-plan` Action-Queue read + `automation_paused` flag** | v5 primitive #1 + v6 PROPOSE/`action_queue` | This is the surface that makes "act in the background" feel like delegation, AND the honest surface that finally lets the "I'll remind in N days" copy be TRUE. Overlaps v6's `action_queue` table. Neither v4 §E nor v7 §4 sequences it. | **Add `action_queue` + `GET /org/automation-plan` as a named slice extending B3** (v6 §7.1 already specs the table). Reconcile v5 W2 and v6 PROPOSE as ONE slice. |
| **O-5** | **Two-track rule + the 6 AI-safety binding rules are NOT in the universal DoD (§A.3)** | v5 §4 (GAP-W1) + v6 §6 | Both passes explicitly say "write into the universal DoD." The v4 §A.3 text does NOT contain the two-track rule or the AI fabrication-firewall rules. A per-slice DoD that omits them lets each slice re-invent feedback/safety badly (as the campaign action already did). | **Amend §A.3 of the master plan** to add: (a) every action declares reversible→undo / irreversible→confirm; (b) the 6 AI-safety rules apply to any slice touching an AI seam. Doc-only, but load-bearing. |
| **O-6** | **The AI-ready foundation slice** (`IAiProvider`+Noop, `IDecisionProvider`+Rule, `CircuitBreaker`, `PiiRedactor`, `action_queue`+autonomy config) | v6 §7.1 | v6 says it's "already in the plan under different names" — but it is NOT in v4 §E. It is deterministic, zero-AI, zero-cost, and the substrate for the entire autonomy story. | **Add a named slice `AI-FOUNDATION` to the Wave-4 tail / Wave-5 region** (after the deterministic loop B1/A1/A2/B3 lands; before any Gemini wave). Non-blocking on Wave 0. |
| **O-7** | **The dedicated AI wave** (Gemini providers + use-cases #1 tabu, #2 draft, #3 digest) | v6 §7.2 + §4 | The owner's explicit "in the future, an AI connection like GEMINI." Entirely DPA/owner-gated, but it has NO wave in the v4 §E master list at all — it would be invisible to an autonomous run that reads only v4. | **Add `Wave 6 — AI (owner/DPA-gated)`** to the master list, explicitly flagged as not-in-autonomous-scope until the DPA decision. Sequencing belongs in the synthesis. |
| **O-8** | **G7 viewed-but-not-signed state** (`signature_requests.viewed` + open-beacon) | v7 §1.5 (verbatim "Not yet homed") | v7 itself flags it as the only G-gap with NO slot. It is "the killer triage signal" for the chase loop — a real product gap, explicitly unhomed. | **Owner scope decision:** add a `signature_requests.viewed` micro-slice (Gate-6 migration, near B2) OR explicitly defer post-MVP. Do not leave it floating. |

---

## 3. THE CONTRADICTION LIST (docs disagree on a fact or scope)

| # | Contradiction | The two sides | Resolution |
|---|---|---|---|
| **C-1** | **"Zero schedulers exist today"** | `v2/DECISIONS-LOCKED §2` ("the API has ZERO scheduler/cron today") + v3/05 premise vs. v4/v7/v5/v6 ("the scheduler ALREADY exists — 3 live sweeps"). **CODE-VERIFIED: v4/v7 are RIGHT.** `apps/worker/src/main.ts` registers reaper (hourly), audit-retention (daily), signature-expiry (hourly) + the import handler — all live `boss.schedule()` calls. | **v2 §2's premise is factually wrong.** The *guardrail* it protects (no "system chased" copy until B3 emits notifications) is still valid and correct — but for the right reason (the sweeps emit ZERO notifications, confirmed: `notification.ts` has 8 kinds, none of `expiring`/`stalled`/`threshold_reached`), NOT because "there is no scheduler." **Reconcile the master plan's prose to: "the scheduler exists; it does not yet CHASE — B3 adds the chase, not the scheduler."** B3 is correctly re-scoped in v4; only the v2 prose is stale. |
| **C-2** | **THREE passes each independently widen the SAME `actor_type` CHECK** | `audit_log.actor_type IN ('user','system','provider')` (CODE-VERIFIED `artifacts.ts:299`). v6 §2.4 widens it to **`+'ai'`**; v7 §3.3 / X5 widens it to **`+'external'`**. Neither pass references the other. Two separate migrations against one CHECK constraint = the second silently conflicts or the first is forgotten. | **ONE migration widens the CHECK to `IN ('user','system','provider','external','ai')`** (or two ordered migrations with explicit awareness). Assign it to whichever of X5 / AI-FOUNDATION lands first; the other consumes it. Carry the schema-constraint-ripple caution (every raw-SQL audit INSERT + the Zod edge). Must be reconciled before the autonomous run authors either migration. |
| **C-3** | **C1 committee print: REBUILD vs PARTIAL** | v4 §B treats C1 as potentially "a net-new server-PDF BE slice" (scary, go-live blocker). v5 §2 explicitly **downgrades C1 to PARTIAL** — "reuse the existing `pdf-signed-document.renderer.ts` pipeline with a new template, not a new renderer." | **Adopt v5's downgrade:** C1 is a PARTIAL (new template over the existing renderer), still a go-live blocker, but NOT a from-scratch renderer. Lowers the risk estimate. Update the master plan's C1 framing. |
| **C-4** | **AV-scan "exists" vs "does not exist"** | The v4 long-flows audit claimed "no AV scan on documents." v7 Appendix #1 + SECURITY-POSTURE + CODE (`artifacts.ts:52-53` `scan_status` + `IFileScanProvider`) all confirm **ClamAV IS wired fail-closed.** v4's own FINAL-BUILD-PLAN already reflects the corrected view (lists ClamAV in §F ops), but the stale claim persists in the v4 *long-flows front* doc. | **No action on the build plan** (already correct). Note for the synthesis: the v4 long-flows front doc carries a retracted claim; do not let any slice "add AV scanning" — it exists. Documentation-hygiene only. |

**Also noted (consistency checks that PASSED — no contradiction):**
- **v4 vs v7 on B0** — agree exactly (B0 = share-weighted consent, ⭐CRITICAL, Wave 1). ✓
- **v4 vs v7 on the critical path** — v7 §4.1 explicitly preserves the v4 4-CRITICAL order (S0-SEC→B5→B0→B3) and slots its own work as Wave 5, not a Wave-0 delay. ✓
- **v6 dual-mode vs v5 action-queue** — reconcile cleanly: v6's `IDecisionProvider.RuleDecisionProvider` IS v5's A2 ranker; v6's PROPOSE/`action_queue` IS v5's primitive #1 / W2. The only seam is naming (flagged O-4). ✓
- **v6 vs v5 on B3** — agree B3 is "add a 4th handler," not "build a scheduler." ✓ (CODE-CONFIRMED.)
- **N11 tabu honesty vs v6 use-case #1** — consistent: v6's `StubExtractionProvider`→manual-entry fallback IS N11's "labeled manual-entry" path; the Gemini drop-in is the later AI wave. ✓

---

## 4. DID WE COVER EVERYTHING? (the answer to my front)

**Over the engine + the job: YES.** Every v2 decision, every v3 design gap (38), every v4
production gap (17), every v7 should-exist gap (14), and the entire security P0/P1/P2 program
has a concrete, sequenced home. There is **no missing-screen / missing-route / missing-rule
class of surprise** left — that was the v3/v4/v7 job and it is done. The route-map coverage is
exhaustive and the "real-job" coverage (v7's two-sided document method) closes the structural
blind spot the route-maps had.

**Over the creative + AI + cross-cutting-rule layer: NOT YET — 5 orphans + 4 contradictions.**
The gap is NOT in the engineering plan; it is that the **v4 FINAL-BUILD-PLAN is the artifact
the autonomous run follows, and it was frozen before v5/v6/v7 folded their additions into its
own §D/§E tables.** So the autonomous run, reading v4, would: (a) silently drop A1/A3/W4/W2/the
AI-foundation (O-1..O-4, O-6, O-7); (b) ship slices without the two-track rule and AI-safety
rules in their DoD (O-5); (c) leave G7 floating (O-8); and (d) risk authoring two conflicting
`actor_type` migrations (C-2). None breaks the engine; all degrade the "feels like it manages
itself" thesis the owner is actually buying, or risk a migration collision.

**The fix is bounded and doc-only:** the synthesis must produce ONE master plan that (1) folds
O-1..O-8 into named slices or explicit defers, (2) reconciles C-1 (scheduler prose) and C-3
(C1 downgrade), (3) merges the v5-W2/v6-PROPOSE and the v6-`'ai'`/v7-`'external'` migration into
single slices (C-2), and (4) amends §A.3 with the two-track + AI-safety rules. After that, the
plan is genuinely complete over all seven passes and safe to run autonomously.

---

## 5. EXECUTIVE SUMMARY (verdict + must-resolve)

**Verdict: GO, conditional — coverage is exhaustive over the engine and the job, but 5
orphans and 4 contradictions must be reconciled into the single master plan first, because the
v4 FINAL-BUILD-PLAN (the artifact the run will follow) was frozen before v5/v6/v7 folded their
additions into its tables.** Every v2 decision (5), v3 design gap (38), v4 production gap (17),
v7 should-exist gap (14), and the full security P0/P1/P2 program is COVERED with a named,
sequenced home — no missing-route/missing-screen surprise remains. The orphans are creative/AI/
rule-layer items each pass *said* it folded in but the v4 plan never tabled: **O-1 A1
reminder-memory** (must precede B3), **O-2 A3 digest**, **O-3 W4 build-from-parcel composite**
(the headline first-session wow), **O-4 W2 automation-plan/action-queue** (overlaps v6 PROPOSE),
**O-5 the two-track + 6 AI-safety rules missing from the universal DoD §A.3**, **O-6 the
deterministic AI-foundation slice**, **O-7 the entire owner/DPA-gated AI wave (unsequenced in
v4 §E)**, and **O-8 G7 viewed-but-not-signed (v7's own "not yet homed")**. The must-resolve
contradictions: **C-2 — three passes independently widen the ONE `actor_type` CHECK
(`'provider'`→`+'ai'` in v6, `+'external'` in v7); merge into a single migration** (code-verified
collision at `artifacts.ts:299`); **C-1 — the v2 "zero schedulers" premise is factually wrong**
(code-verified: 3 live cron sweeps in `apps/worker/src/main.ts`); reconcile the prose to "the
scheduler exists but does not yet chase"; **C-3 — adopt v5's C1 downgrade** from net-new
server-PDF to a template over the existing renderer; **C-4 — AV scan EXISTS** (no slice may
"add" it). None is a design error; all are doc-reconciliation items the synthesis closes before
the autonomous run begins.
