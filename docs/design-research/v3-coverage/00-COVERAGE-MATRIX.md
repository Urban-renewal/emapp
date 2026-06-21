# 00 — MASTER COVERAGE MATRIX & COMPLETENESS VERDICT (v3)

> **Role:** Design Lead synthesis seat. Integrates the six v3 dimension audits
> (`01-screens` · `02-interactions` · `03-domain-logic` · `04-roles` ·
> `05-backend` · `06-crosscutting`) against the APPROVED plan
> `docs/design-research/v2/00-MASTER-PLAN-V2.md` (+ `DECISIONS-LOCKED.md`,
> `DESIGN-NORTH-STAR.md`). Author: 2026-06-18. READ-ONLY.
>
> **Purpose.** The owner wants to *plan once and build the whole redesign in one
> pass* with nothing discovered mid-build. This doc (1) scores each dimension's
> coverage, (2) consolidates + de-duplicates **every** gap into one ranked
> register with a roadmap home for each, and (3) renders the completeness verdict.
>
> **Method note — I independently re-verified the load-bearing factual claims** the
> dimension docs rest on, because two of them change the verdict (see §0).

---

## 0. Verification of the load-bearing claims (what I re-checked in real code)

Before consolidating, I re-ran the greps the dimension docs depend on. Two
results **correct** the v3 docs themselves and de-escalate one "critical" gap:

| Claim under test | v3 doc said | What the code actually shows | Effect |
|---|---|---|---|
| `ConfirmDialog`/`useConfirm` exists | **06/X1: "does NOT exist, no file, no git history — build net-new"** | **PARTLY WRONG.** It exists, fully a11y-correct (role=alertdialog, ESC, focus-trap, focus-to-cancel, `.btn-danger` token, + spec + i18n), built **today (2026-06-18, commit `becce1d`)** on the unmerged branch `fix/styled-confirm-dialog`. It is **NOT on `main`** and not in the current working tree. | The remedy is **"land/rebase an existing PR," not "build from scratch."** Materially smaller. X1 over-stated. |
| Live destructive confirms | 02/G1 + 06/X2: "17 live `window.confirm`" | **CONFIRMED: exactly 17** in the working tree (`grep window.confirm apps/web/src` = 17). The `becce1d` branch already replaces all 18 originals. | G1/X2 real **on main**, but already solved on a branch — fold by **merging**, not authoring. |
| Public signer gets tokens | 01/G-SIGN + 04/G6: "token re-skin reaches it ONLY if `sign/layout` pulls the stylesheet — UNVERIFIED" | **VERIFIED FALSE CONCERN:** `apps/web/src/app/sign/layout.tsx` **does** `import '../globals.css'`. The signer page **inherits the token re-skin for free.** | G-SIGN downgrades: the *tokens* reach it; only its bespoke inline styles / consent-UX copy are unscoped. P0→P1. |
| Viewer lands on a home it can't read | 04/G5 | **CONFIRMED.** `(dashboard)/page.tsx` = `me.role==='agent' ? AgentHome : ManagerHome` → Viewer gets ManagerHome; `system-roles.ts:110,123` excludes viewer from `stats`/org internals. | G5 holds — a real role-surface break the home-rewrite slice (E2.1) never names. |
| Zero prod schedulers / `decline_reason`=0 / holdout-name not selected | 05 (B2/B3/B4 premises) | **CONFIRMED** (05 §VERIFICATION re-checked independently and I concur). | B1–B4 premises sound. |

**Net effect of §0:** the cross-cutting doc's single biggest "critical grounding
error" (X1) is **half-retracted** — the primitive is built; it just isn't merged.
That moves the "build a modal from scratch" fear off the board and replaces it with
a much cheaper "merge `fix/styled-confirm-dialog` + ratchet the new class-guard over
it" task. The signer-tokens fear (G-SIGN P0) also de-escalates. Everything else
stands.

---

## 1. Per-dimension coverage scorecard

| Dimension | Inventoried | COVERED | CHANGED | AS-IS-OK | **GAP** | Thinness / confidence note |
|---|---|---|---|---|---|---|
| **01 Screens / routes** | 48 page.tsx (+12 layout/error/not-found = 60 files) | ~10 | ~13 | ~5 | **~25** | Strong — enumerated from the tree; exposed the plan's stale "55". One P0 (sign) de-escalated by §0. |
| **02 Interactions / writes** | ~70 mutation hooks + ~40 form/dialog surfaces | ~14 | ~6 | ~10 | **~40 GAP/PARTIAL** | Strong & exhaustive. G1 (17 confirms) confirmed; remedy already on a branch (§0). |
| **03 Domain logic** | 62 rules / 11 categories (27 modules) | 16 | 6 | 27 | **13 (+~5 adjacent)** | Strong — audited modules the council skipped. G1 (share calc) + G3 (status guard) are the sharpest. |
| **04 Roles × surface** | ~70 role/surface items (6 roles) | ~14 | ~16 | ~17 | **~23 (9 themes)** | Strong. Structural finding (3 of 6 roles out of scope) is the dimension's spine. |
| **05 Backend / endpoints** | 45 controllers / ~150 routes + B1–B4 | bulk | bulk | bulk | **8** | Strong — re-verified all 4 greps. GAP-1 (B4) + GAP-2 (B1 schema) are the one-shot risks. |
| **06 Cross-cutting** | ~58 items / 7 groups | ~33 (incl AS-IS) | ~16 | — | **~12** | Solid, but **X1 over-stated** (§0). X3 (security P0 unreconciled) is the durable one. |

**Coverage shape across all six:** the plan is **deep and correct on its chosen
keystones** (board-first IA, chase loop, tokens+leak-guard, consent-basis label,
the 4 honest BE slices, the DO-NOT-FABRICATE register) and **broad-but-shallow or
silent everywhere else.** Every dimension independently reports the same shape:
*exemplar-driven, not enumerated.* The plan picked ~9–10 representative surfaces
per dimension, stated the doctrine, and left the long tail to a "Wave 4 / slot by
owner priority" bucket that the roadmap never actually sequences.

---

## 2. CONSOLIDATED GAP REGISTER (de-duplicated, ranked, with a roadmap home)

Gaps that appeared in multiple dimension docs are merged (cross-refs shown). Each
carries **where it slots** in MASTER-PLAN-V2 — an existing wave/slice, or a NEW
slice the plan has no home for. Ranked by one-shot-build risk.

### TIER A — P0 — *will* cause a mid-build surprise or ship something broken/wrong

| # | Gap (merged sources) | Why it breaks one-shot | Roadmap home |
|---|---|---|---|
| **A1** | **Share-weighted consent calc is DECIDED (DECISIONS-LOCKED §1) but never written as a concrete slice.** No SQL for per-building `GROUP BY`, partial-share credit (OD-3), or the SHELL-owner denominator effect. `P0-FIX` is mis-marked "Blocked on OD-1" although OD-1 is what §1 un-blocked. *(03/G1·A3·A4·A5, 03/G11, 05 consent row)* | The single most important number in the product is left a stub while board-first amplifies it. Every basis-labeled headline, the print artifact (C1), and the M3 celebration consume it. | **PROMOTE `P0-FIX` out of Wave 3 into Wave 0/1.** Re-author as a concrete slice: share-weighted CTE + per-building GROUP BY + partial-credit + SHELL-denominator decision + the `metThreshold` wire-shape (A2). Un-mark "Blocked." |
| **A2** | **`metThreshold` post-change wire-shape undefined.** Which boolean the FE reads after the denominator flips; whether `consentedPct` (by-heads) survives on the wire as the supporting line; how the 3 specs asserting the binary migrate. *(03/G2·A2)* | Wire ambiguity = mid-build rework across home, board, list, and the M3 celebration gate. | **Fold into A1's slice** (same P0-FIX). Pin the `signature-progress` response contract explicitly. |
| **A3** | **No project-status-transition guard exists** — `projects.service.ts:762` accepts any status→any status. Board-first "mark approved / you can file" wires to an ungated setter with no `metThreshold` precondition. *(03/G3·D2)* | A board-first "approve" action becomes a silent illegal-transition footgun. | **NEW SLICE `B5 — status-transition guard`** (Wave 1, BE, no migration): a state machine + `metThreshold`-before-`approved` precondition. Plan has **no home** for this today. |
| **A4** | **B4 (holdout-name PII read) is named but its route/shape/gate is unspecified** — and the "מי תקוע → tap → name" FE flow (M2/E2.2-S3) depends on it. *(05/GAP-1, 04/—, 01/board)* | The single most likely "missing screen discovered mid-build" event: the FE flow has no backend. | **Specify B4 concretely in Wave 2** (e.g. `GET /projects/:id/signature-progress/apartments/:apartmentId/holdouts`, `view_owner_pii`-gated, audited). Already a named slice — just under-specified. |
| **A5** | **B1 pulse schema undercounts what E2.1/E2-list consume** — `ProjectPulseRow` never pins `lastSignatureAt`/`signedThisWeek`/`stalledDays`/`nextExpiryAt`, yet "sort-by-momentum" + the home momentum chip read them. *(05/GAP-2)* | Momentum signals ship un-backed; sort-by-momentum is unbuildable. | **Pin the row contract inside B1 (Wave 2)** — extend `05 §2.A` canonical schema with the per-project derivations. |
| **A6** | **Expiring-soonest sort (C6/M2) has no data path pre-B3** — the project/board lists never join `expires_at`. *(03/G4·E3, 05/—)* | C6 "sort by expiring-soonest" is promised in Wave 2 but unbuildable; chase-queue triage stalls. | **Add a derivable `nextExpiryAt` per project to B1 (Wave 2)** (folds into A5) OR a small read in E2-list. No home today. |
| **A7** | **17 live `window.confirm()` on `main` contradict the "undo over confirm" doctrine; the migration is on an unmerged branch only.** *(02/G1, 06/X2; §0 correction)* | A one-shot build off `main` ships ~14–17 native confirms intact — the literal anti-pattern the redesign exists to invert. | **NEW SLICE `M0b — land ConfirmDialog + migrate confirms` (Wave 0).** Remedy = **rebase/merge `fix/styled-confirm-dialog` (becce1d)** onto the E2 baseline, then ratchet the new class-guard over it. NOT net-new authoring. |
| **A8** | **Provider-Admin tier (8–10 wired pages + `PCSidebar`) is invisible to the plan** ("provider" appears 0× in the master plan); `provider/system-health` hard-codes `bg-emerald/amber/red` leaks → the §3.5 class-guard ratchets from a **false floor across a whole tier.** *(01/G-PROVIDER-TIER, 04/G1, 06/X5)* | Guard-honesty hole + a whole tier ships un-redesigned and re-rots. | **Wave 0 §3.5 baseline MUST include the provider subtree** (guard correctness = P0). The **visual re-skin** of the 8 provider screens = **NEW SLICE `C12 — provider-tier re-skin`** (Wave 4, P1). |
| **A9** | **The §3.5 leak-guard baseline is measured from a false floor** — it names only 3 unopened surfaces; the real unopened set adds the 10 provider screens (A8) + every `*/new`/detail form + settings/member panels (`text-emerald-*`/`bg-red-*`). *(01/G-RESKIN-FLOOR, 02/G3, 04/G3·G4, 06/§7)* | Freezing the guard low means it ratchets from a lie and lets leaks survive. | **Wave 0 / E2.0:** re-measure the baseline across the **full** `components/**`+`app/**` tree (incl. provider, all forms, member/settings panels) before freezing. |

### TIER B — P1 — real, persona-critical, will need a patch wave if skipped

| # | Gap (merged sources) | Roadmap home |
|---|---|---|
| **B1** | **Auth/onboarding cluster (login·signup·forgot·reset·accept-invite·tenant-login·provider-login) has no slice** — first-touch + team-onboarding surface; P0-ranked in the completeness critique, unscheduled. *(01/G-AUTH-ONBOARD, 04/—)* | **NEW SLICE `C13 — auth/onboarding re-skin` (Wave 1).** Token re-skin reaches them only if they sit under `[locale]/layout` — verify per page. |
| **B2** | **Settings/admin config forms (6 settings configs + role-editor + member-capabilities/overrides panels) have ZERO interaction + leak coverage** — non-dismissing `saved` lines + hardcoded `emerald`/`red`. *(02/G2·G3, 04/G-member, 06/—)* | **Fold into A9 (leak) + extend M0's inline-feedback migration (Wave 0) to enumerate all ~11 sites,** not "~4". |
| **B3** | **B2 migration's status-CHECK widen ripples to ~6 status-label maps + every raw seeder** — unbudgeted multi-file patch wave. *(05/GAP-5, 03/B3)* | **Add a ripple checklist to the B2 slice (Wave 3):** STATUS_LABELS, `statusColor→intent`, contractor portal status, all raw-SQL test INSERTs. |
| **B4** | **C1 print-of-record (the product's raison d'être) is budgeted FE-only** but a committee/lawyer artifact likely needs a server-rendered audited PDF (precedent: `signed-document`). *(05/GAP-4, 06/PII-egress)* | **Re-scope C1 (Wave 4 → promote to P0-class):** decide print-stylesheet vs server PDF *now*; it must carry the basis label (§6.1) + a PII-egress cue. |
| **B5** | **`apartments/[id]/ownerships` (the share-num/den ENTRY screen) is untouched** — the exact input the new share-weighted headline depends on. "Redesigned the output, ignored the input." *(01/G-DETAIL-FORMS, 03/G11, 04/—)* | **Add to A1's slice scope (Wave 1):** the ownerships editor is part of the consent-correctness surface, not a stray `*/new` form. |
| **B6** | **Recipient-association gate (`recipient_not_associated` 409) is invisible to the chase loop** — sending a project doc to a globally-searched owner will 409 with no calm surface. *(03/G6, 05/—)* | **Add to M2 (Wave 2):** design the calm error envelope for `recipient_not_associated`; the chase slice currently assumes "send just works." |
| **B7** | **Tenant portal + tenant-OTP login un-redesigned** (counterparty home for the least-technical user); carries the same leaks, outside the §3.5 baseline. *(01/G-TENANT-PORTAL, 04/G4)* | **NEW SLICE `C14 — tenant portal + OTP` (Wave 4, P1)** — currently only a vague C11 bundle line. |
| **B8** | **Contractor share view (C7) + contractor layout/CRUD floats with no wave/gate/owner-priority slot;** drops BE lifecycle to one opaque `invalidLink`. *(01/G-CONTRACTOR, 04/G3·G9)* | **Give C7 a real Wave-4 slot** + reconcile `external_read` role vs cookie-token path (04/G9). |
| **B9** | **Messages surface (send/create/mark-read) is interaction-invisible AND its 6 endpoints have no data-plan after the topbar demotion** — and it's an in-flight owner epic. *(02/G4, 04/G8, 05/GAP-3)* | **NEW SLICE `C15 — messages topbar cluster` (Wave 4):** optimistic send + toast + the panel's data source + `/messages?c=` deep-link survival. |
| **B10** | **Security P0 program (global `APP_PIPE` + `input-validation-coverage` guard + `.strict()` queries + magic-byte) is referenced by ZERO v2 docs,** yet E2 ships 4 new BE surfaces (B1/B2/B4/S4). *(06/X3)* | **Fold SECURITY-POSTURE P0.1+P0.2 into Wave 0** so the new endpoints land validated by construction, not per-endpoint convention. |
| **B11** | **Viewer home is broken (lands on ManagerHome → reads `/org/stats` it can't) and E2.1 only names Agent convergence.** *(04/G5; §0 confirmed)* | **Add Viewer to E2.1 (Wave 2):** the role branch must route Viewer to a read-only mission-control, not ManagerHome. |
| **B12** | **`formatRelative` is also the Hebrew dual/plural seam** — tz fix is planned (P-TZ-1) but ICU plural copy ("שתי חתימות") is unowned, and the redesign's count sentences are core. *(06/X9, 06/dual-plural)* | **Add an ICU-plural + native-Hebrew-copy sub-task to P-TZ-1 (Wave 0).** |

### TIER C — P2 — completeness / consistency; safe to schedule but name them

| # | Gap (merged) | Home |
|---|---|---|
| **C-a** | **~15 `*/new` + detail forms** (owners/new, contractors/new, members/new, tasks/new, notes/new, documents/new, signature-requests/new, buildings.../new, building/apartment detail, task/note/sig-request detail) only "keep responding." *(01/G-DETAIL-FORMS, 02 AS-IS rows)* | Re-skin sweep (E2.0b tokens reach them); explicit "no interaction redesign" decision. |
| **C-b** | **Import/Tabu/Discovery write-rules that FEED the board are out of domain scope** (national_id-mandatory import rows, tabu draft→confirmed share-derive, discovery status). *(03/G9·H, 05/discovery)* | C8 (import) + C10 (discovery, scope decision) — audit the rules before any "set up project / approve owners" flow. |
| **C-c** | **`signatureMilestones` (staged targets, already modeled) ignored** by the ThresholdProgress redesign. *(03/G12·A10·F7)* | Add a milestone-overlay decision to the ThresholdProgress hero (§3.4). |
| **C-d** | **Member-permission OVERRIDE engine absent from the authz/IA plan** — a redesigned Access tab could desync. *(03/G10, 04/—)* | Name it in the Admin-group / Access-tab slice. |
| **C-e** | **Renter exclusion the plan cites as LIVE logic is dead code** (migration 0066; `RelationshipSchema=z.enum(['owner'])`, `resolveRenterOnly` no-op). *(03/G5·C6·C7)* | Correct the plan's mental model; any "exclude renters" copy/logic is solving a non-problem. Occupant/renter now lives in `discovery_records`. |
| **C-f** | **Owner PII reveal is a plain button (not StepUp) on the owner surface** — plan assumes one consistent step-up flow; there are two. *(02/G5, 06/—)* | Reconcile in M6 (StepUp a11y) — decide whether owner reveal gets the same gate as documents. |
| **C-g** | **`/org/stats` fate unstated after the home is replaced** (dangling-endpoint vs double-fetch risk). *(05/GAP-7)* | One line in E2.1: retire or repoint `/org/stats`. |
| **C-h** | **Populated calendar (C11) has `tasks.due_at` + ICS generator but no read/feed endpoint.** *(05/GAP-8, 03/E5)* | C11 scope decision; needs a net-new `GET /calendar` feed if pulled in. |
| **C-i** | **B3 worker's net-new notification kinds + locking unscoped** (no "expiring"/"stalled"/"threshold" kind in `notification-links.ts`). *(05/GAP-6, 03/E2·E4)* | Spec the new kinds + deep-link targets inside B3 (Wave 3). |
| **C-j** | **Offline banner + paused mutations (C4), empty-org first-run (C3), bidi-interpolation static guard, PII-egress cue, "no countdown" session-UX stance, perf LCP-vs-M3 gate, `en`-is-real decision (OD-5).** *(06/X4·X6·X7·G2, 05/—, 03/—)* | C3/C4 already named (promote C3 to P0-class per the plan's own note); the rest are Wave-0 doctrine lines that need an explicit owner decision. |
| **C-k** | **Agent capability re-test matrix after nav 14→5 + board-first** — a promoted control (campaign-send) must not render for an agent with `manage_signatures` OFF. *(04/G7)* | Add a per-control agent matrix to the per-role smoke gate (already in the universal DoD; make it explicit). |
| **C-l** | **Plan's surface counts are stale** ("55 page.tsx" / "~64 routes" vs real **48 page.tsx**; "16 PCSidebar" vs 14). *(01/G-COUNT-MISMATCH, 04/G1)* | Credibility only — correct the numbers so the inventory is trustworthy. |

---

## 3. New slices the plan has NO home for (net-new work, summarized)

The roadmap as written cannot absorb these without a new line item:

1. **`B5` status-transition guard** (A3) — BE, Wave 1.
2. **`M0b` land + ratchet ConfirmDialog** (A7) — merge `fix/styled-confirm-dialog`, Wave 0.
3. **`C12` provider-tier re-skin** (A8) — Wave 4 (but its leaks must enter the Wave-0 guard baseline now).
4. **`C13` auth/onboarding re-skin** (B1) — Wave 1.
5. **`C14` tenant portal + OTP** (B7) — Wave 4.
6. **`C15` messages topbar cluster + data plan** (B9) — Wave 4.
7. **Promote `P0-FIX` (share-weighted consent) from Wave 3 → Wave 0/1** and re-author it concretely (A1+A2+B5-ownerships).

Plus **scope-promotions** of existing lines: C1 → P0 server-PDF decision (B4); SECURITY P0.1/P0.2 → Wave 0 (B10); Viewer → E2.1 (B11); the §3.5 baseline → full-tree re-measure (A9).

---

## 4. Honest assessment of the dimension docs themselves

- **01 / 02 / 03 / 04 / 05** are strong, exhaustive, and tree-grounded. I spot-checked their sharpest claims (status-guard absence, viewer break, B1–B4 greps, 17 confirms) and they hold.
- **06 is the weakest on one point only:** its flagship X1 ("ConfirmDialog doesn't exist, build net-new") is **half-wrong** — the component exists and is fully built on an unmerged branch from today. Its *other* findings (X3 security-P0 unreconciled, X6 `en`-open, X9 plurals, the token bugs) are solid. I have re-classified X1/X2 as **A7 (merge-not-build)** above.
- **The recurring true finding across all six** is identical and therefore high-confidence: **the council scoped to ~10 exemplar surfaces of the org Manager tier and stated doctrine for the rest.** That is the structural gap, not any single screen.

---

## 5. COMPLETENESS VERDICT

**Verdict: `ready-after-gap-fill`.**

The plan is **architecturally correct and its keystones are exhaustive** — board-first
IA, the chase loop, the token system + leak guard, the consent-basis interim rule, the
four honest BE slices, and the DO-NOT-FABRICATE register are all real, cited, and
sound. The "re-composition not re-routing, every route still responds" safety guarantee
holds. There are **no fatal design errors** and (after §0) no "build a missing primitive
from scratch" surprise.

But it is **NOT yet exhaustive enough to build end-to-end in one pass as written**,
because the long tail the council bucketed into "Wave 4 / slot by owner priority" contains
**9 P0 gaps** that *will* surface mid-build — most sharply: the share-weighted consent
calc is decided but unwritten and mis-deferred to the end (A1/A2); there is no
status-transition guard for the board-first "approve" action (A3); B4's holdout-name
endpoint that the keystone chase flow depends on is unspecified (A4); and an entire role
tier (Provider-Admin) plus the §3.5 leak-guard baseline are measured from a false floor
(A8/A9). Three of six roles (Provider-Admin, Tenant, Contractor) and the entire
auth/onboarding first-touch cluster have no sequenced slice.

**Once the Tier-A gaps are folded in** — promote and concretely re-author the consent
slice into Wave 0/1, add the B5 status guard, specify B4, pin the B1 row schema, expand
the leak baseline to the full tree (incl. provider), merge the already-built ConfirmDialog,
and create the auth/tenant/messages/provider re-skin slices — **the plan covers every
interface and every load-bearing logic, and the owner can build it in one pass.** The
Tier-B/C gaps are real but absorb into existing waves with explicit scope lines rather
than mid-build discovery.

**The one sentence for the owner:** the design direction is right and the spine is fully
planned; fold in the ~9 P0 gaps above (most are *re-sequencing and concretizing decisions
already made*, plus six small new re-skin slices), and the surprise risk drops to near
zero.
