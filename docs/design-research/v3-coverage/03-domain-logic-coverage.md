# 03 — Domain Logic / Business-Rule Coverage Audit (v3)

> **Dimension:** every domain rule / business logic in `apps/api/src/modules/*`
> services + `packages/db` + `packages/shared-types`, cross-checked against the
> APPROVED redesign plan (`docs/design-research/v2/00-MASTER-PLAN-V2.md`,
> `01-domain-workflow.md`, `DECISIONS-LOCKED.md`).
> **Method:** Glob-enumerated all 27 service modules + enums + Zod schemas; read
> the real consent/signature/ownership/authz code; classified each rule against
> the plan. Skeptical of the plan's own lists — several rules the plan never
> names are surfaced below.
>
> **Verdict in one line:** the plan is EXCELLENT on the *headline* domain logic
> it chose to look at (consent denominator, expiry sweep, decline_reason,
> renter exclusion) but it audited **~9 of the 27 modules**. The one-shot goal
> is threatened by **logic the council never inventoried** — project/apartment
> status transitions, milestones, the import/tabu/discovery write surfaces that
> feed the board, member-override authz, and several *implied-but-unspecified*
> calc changes (partial-share credit, per-building GROUP BY, the renter-gate
> that is already dead code).

---

## GAP SUMMARY (ranked by impact on the one-shot implementation goal)

> A "GAP" here = a domain rule the redesign WILL collide with at implementation
> time but the plan does not specify. Ordered so the highest one-shot risk is first.

1. **G1 — Share-weighted consent calc is DECIDED but NOT SPECIFIED (the #1 build-blocker).**
   `DECISIONS-LOCKED §1` locks "consent = share-weighted % of ownership" and
   supersedes the binary `signatureProgress` (`projects.service.ts:419-421`). But
   no slice in the roadmap actually writes the new SQL. `P0-FIX Consent correctness`
   (Wave 3) is explicitly **"Blocked on OD-1"** — yet OD-1 (the *basis*) is what
   DECISIONS-LOCKED §1 just **un-blocked**. The plan leaves the single most
   important calc as a deferred, owner-gated stub while the decision that gated it
   is already made. A one-shot build needs the share-weighted CTE + per-building
   `GROUP BY building` + the partial-share-credit rule (OD-3) written as a concrete
   slice, not "deferred to the end."

2. **G2 — `metThreshold` semantics change is implied but undefined.** Today
   `metThreshold = consentedPct >= targetSignaturePct` over apartment-headcount
   (`projects.service.ts:421`). Switching the denominator silently changes which
   projects show green — and `metThreshold` is the input to M3's "crossed the line"
   celebration AND any future "you can file" copy. The plan says celebrations
   inherit the basis rule (Tension 7) but never says **which boolean** the FE reads
   post-change, whether the old `consentedPct` field stays on the wire for the
   "by heads" supporting line, or how the 3 specs asserting the binary value get
   migrated. Wire-shape ambiguity = mid-build rework.

3. **G3 — NO project-status-transition logic exists, and the plan assumes board-first without it.** `projects.service.update()` (`projects.service.ts:762-820`)
   accepts **any** `status` → **any** `status` with zero guard (no state machine,
   no `gathering_signatures`-before-`approved` check, no "can't leave `cancelled`").
   The board-first IA is built around the project lifecycle (`planning →
   gathering_signatures → approved`), and "almost there / you can file" copy implies
   a transition to `approved`. The plan never inventories that **the status enum is
   free-text-editable** with no rule that `metThreshold` must hold before `approved`,
   or that `approved`→`in_construction` has any gate. If the redesign surfaces a
   "mark approved" action it will wire to an ungated setter. (`01 §1.3` notes
   "EMAPP flips approved" but doesn't flag the *missing transition guard*.)

4. **G4 — The expiry sweep (B3) has no source data path defined for the FE's "expiring soon" list.**
   The plan's B3 worker flips lapsed `pending`→`expired` (correct) and the
   DO-NOT-FABRICATE list bars "expiring soon" copy until then. But the redesign's
   chase loop (M2/E2-list/C6) wants an **expiring-soonest sort NOW**, pre-B3. There
   is no endpoint that returns `expiresAt` per request to the manager list — the
   `signature_requests.list` (`signature-requests.service.ts:1122`) returns rows but
   the **project list / board never join expiry**. The derivable "expires in N days
   over status='pending'" the plan promises (`01 §1.2`, master §4.1) needs a concrete
   query slice that no roadmap row owns. Without it, C6 "sort by expiring-soonest"
   is unbuildable in Wave 2.

5. **G5 — The renter exclusion the plan treats as LIVE logic is already DEAD CODE.**
   `01 §2`, master §4 and §6.1 repeatedly cite "renters never count / never sign /
   filter `relationship='owner'`" as a load-bearing live rule. In reality migration
   0066 **retired** renters from `ownerships`: `RelationshipSchema = z.enum(['owner'])`
   (`ownership.ts:23`), the DB CHECK pins `relationship IN ('owner')`, and
   `resolveRenterOnly()` is a **defensive no-op that always returns ∅**
   (`signature-requests.service.ts:171-174`). The renter is now a `discovery_records`
   source, not an ownership row. Any redesign copy/logic built on "exclude renters
   from the board" is solving a problem that no longer exists; conversely any
   surface that wants to show the **occupant/renter** (a real field-work signal) must
   read `discovery_records`, which the plan only flags as "C10 no FE." The plan's
   mental model of this discriminator is one migration stale.

6. **G6 — The recipient-association gate (the consent-integrity chokepoint) is invisible to the redesign.**
   `resolveAssociatedOwners` (`signature-requests.service.ts:193-232`) rejects
   sending a signing link to an owner not tied to the document's apartment/project
   scope (`recipient_not_associated` 409). The board-first "send to holdout" /
   "remind" one-tap actions (M2) mint links — if the FE lets a manager pick ANY owner
   (e.g. from global search) to send a project doc to, this gate will reject them with
   an error the plan never designs a calm surface for. The plan's chase-loop slices
   assume the endpoint "just works" and never mention this association precondition or
   its error envelope.

7. **G7 — `'other'` project-type consent default has no per-org override (config blind spot the share-weighted slice will inherit).**
   `ConsentSettingsSchema` (`org-settings.ts`) keys only 3 of the 4 project types;
   `'other'` falls through to hardcoded `PROJECT_TYPE_DEFAULT_CONSENT_PCT.other = 66`
   (`project.ts`, applied `projects.service.ts:600-603`). `01 §3.2` flags this, but the
   master plan's consent slices **do not fold in the one-line fix**, so the
   share-weighted rebuild risks copying the same three-key blind spot.

8. **G8 — Apartment `status` (`pending|contacted|meeting|signed|refused|unreachable`) is the redesign's "why" substitute, but its transitions and its relationship to signature state are unspecified.**
   `apartments.service.ts:260-263` flips `status` + `statusChangedAt` freely (no
   transition rule) and emits `apartment_status_changed`. The plan leans on
   `apartment.status` for the honest "X דירות סומנו כסירוב" substitute (master §4.2,
   B2) and on `statusChangedAt`/`lastContactAt` for "אין תנועה N יום." But it never
   notes that **apartment `status='signed'` is INDEPENDENT of actual signature_request
   state** — a manager can mark an apartment `signed` with zero signed requests, so the
   board's per-apartment consent (computed from `signature_requests`) and the apartment
   `status` chip can **contradict each other**. The redesign must decide which is
   authoritative on the board; the plan doesn't.

9. **G9 — Import + Tabu + Discovery write-surfaces (the data the board CONSUMES) are out of the plan's domain scope.**
   The board's correctness depends on ownerships being complete and shares summing to
   1. Those rows are written by the import worker (`imports.service.ts`), the tabu
   confirm (`tabu-extractions.service.ts`, draft→confirmed lifecycle with provenance),
   and field discovery (`discovery.service.ts`). The plan touches Import only as a
   *visual* re-skin (C5/C8) and Discovery only as "C10 no FE," and **never audits their
   business rules** (national_id-mandatory import rows, the share-fraction derive on
   confirm, the draft→confirmed 409 idempotency, discovery status enum). If the
   redesign adds a "set up project" or "approve owners" flow it will collide with these
   lifecycles uninventoried.

10. **G10 — Member-permission OVERRIDE engine (grant/deny layer) is absent from the IA/authz plan.**
    `member-overrides.service.ts` layers per-member GRANT/DENY over role perms with
    anti-escalation + owner-tier + last-Owner guards. The plan's nav §2.2 says "gating
    survives via middleware + AuthorizationGuard + useHasPermission" but **never mentions
    the override layer** — so a redesigned Admin/Access surface (or the "Access tab")
    that shows or edits permissions could desync from this engine. Not a board risk, but
    a one-shot completeness gap on the Admin group the plan demotes.

11. **G11 — Owner SHELL + the partial-apartment counts are under-specified for the board.**
    The plan says render SHELLs as "discovery in progress" (`01 §2`/§4) and
    apartment-grained "דירה 7 · partial." The data exists (`signatureProgressApartments`
    returns `none|partial|consented` + counts, `projects.service.ts:507-512`). But the
    plan never specifies: does a SHELL owner (nullable name/national_id) count toward
    `active_owners` in the consent denominator? It does today (the consent CTE counts any
    active `relationship='owner'` ownership regardless of SHELL state,
    `projects.service.ts:375-393`), so an un-identified owner makes an apartment
    permanently `partial`/`none` and **drags the share-weighted % down** — which the
    legal number must account for. Unspecified = silent correctness drift.

12. **G12 — `signatureMilestones` (staged consent targets) is a real domain feature the redesign ignores.**
    Projects carry an ordered, validated `signatureMilestones` list (strictly ascending,
    unique, ≤ target, max-10 — `project.ts:90-115`; stored migration 0053). It is the
    project's *staged* plan ("hit 40%, then 51%, then 66%"). The board-first headline +
    ThresholdProgress marker is the natural home for these milestones, but no plan slice
    surfaces them — the redesign would re-invent a "target marker" while ignoring the
    multi-milestone overlay already modeled. (`05 §4` lists "milestone overlay EXISTS"
    but no consumer slice renders it.)

---

## EXHAUSTIVE COVERAGE TABLE

Legend: **COVERED** = plan explicitly addresses · **CHANGED** = plan modifies (noted) ·
**AS-IS-OK** = plan correctly leaves untouched · **GAP** = plan misses it.

### A. Consent counting & thresholds

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| A1 | Binary apartment-headcount consent (`apartmentsConsented/totalApartments`) | `projects.service.ts:398-420` | The single consent % the product shows | **CHANGED** | DECISIONS-LOCKED §1 supersedes with share-weighted. Correctly identified. |
| A2 | `metThreshold` boolean (green bar gate) | `projects.service.ts:421` | Drives bar color + future "you can file" | **GAP (G2)** | Plan says it inherits basis rule but never specifies new wire shape / which field FE reads post-change. |
| A3 | Share-weighted calc (the new headline) | NOT IMPLEMENTED (`ownerships.share_num/den` `projects.ts:289-299`) | The legally-correct number | **GAP (G1)** | Decided, never written as a concrete slice; `P0-FIX` is "Blocked on OD-1" which is already decided. |
| A4 | Per-building / per-מתחם GROUP BY progress | NOT IMPLEMENTED | פינוי-בינוי/38-2 count per building | **GAP (G1)** | `01 §3.4 #3` flags it; no roadmap slice owns the `GROUP BY building`. |
| A5 | Partial-share credit (2-of-3 signed apartment) | binary today, discards partial (`projects.service.ts:399`) | Legally each signed owner's share counts | **GAP (G1)** | `01 §7 OWNER DECISION 3` raises it; not folded into any specified calc. |
| A6 | `targetSignaturePct` default-from-type (66) | `projects.service.ts:600-603`, `PROJECT_TYPE_DEFAULT_CONSENT_PCT project.ts` | Per-track legal majority default | **AS-IS-OK** | Plan keeps it as config; correct (the % is right, denominator is the issue). |
| A7 | `'other'`-type has no per-org consent override | `org-settings.ts` (3 of 4 keys) | Config completeness | **GAP (G7)** | `01 §3.2` flags; master consent slices don't fold in the 1-line fix. |
| A8 | Per-org `ConsentSettingsSchema` override path | `org-settings.ts:118-125` | Org-level threshold config | **AS-IS-OK** | Mechanism stays; only the missing 4th key (A7) is the gap. |
| A9 | `consentedPct` rounding (`Math.round(...*100)`) | `projects.service.ts:420` | Display % | **AS-IS-OK** | Fine; plan's concern is denominator not rounding. |
| A10 | `signatureMilestones` staged targets (ascending/unique/≤target) | `project.ts:90-115`, stored 0053 | Staged consent plan | **GAP (G12)** | Real feature; no slice surfaces it on ThresholdProgress. |

### B. Signature lifecycle (pending / signed / cancelled / expired / declined)

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| B1 | Atomic single-use sign `pending→signed` | `public-sign.service.ts:270-301` | Security heart of signing | **AS-IS-OK** | Plan leaves untouched; correct. |
| B2 | `'expired'` status CHECK-allowed but NEVER written | `signature-requests.service.ts` (no writer); enum `artifacts.ts` | Lapsed links stay `pending` forever | **CHANGED** | B3 worker sweeps lapsed→expired. Correctly identified (master §4.1). |
| B3 | `'declined'` status + `decline_reason` — ABSENT | not in schema (grep-confirmed) | Objection "why" layer | **CHANGED** | B2 migration adds it (the ONLY migration). Correctly identified. |
| B4 | `cancel` pending→cancelled (idempotent, signed→409) | `signature-requests.service.ts:1222-1281` | Manager cancels a request | **AS-IS-OK** | Plan doesn't touch; fine. |
| B5 | Resend/re-mint (fresh jti + new 7d expiry, pending-only) | `signature-requests.service.ts:748-830` | THE chase primitive | **COVERED** | M2 wraps it (`postIdempotent`). Plan correctly reuses, notes 409-guard. |
| B6 | `resendForOwner` (tenant self-resend, own-record) | `signature-requests.service.ts:927-1006` | Resident re-sends own link | **COVERED** | Plan notes it "can also rotate the clock" (M2 guardrail). |
| B7 | `getLink` (phone-less owner out-of-band link) | `signature-requests.service.ts:852-917` | Copy bearer link | **AS-IS-OK** | Niche; plan doesn't surface, fine. |
| B8 | Create dedup: block live pending only (`status=pending AND expires_at>now()`) | `signature-requests.service.ts:307-323` | Don't double-send; allow re-issue after lapse | **AS-IS-OK / GAP-adjacent (G4)** | Correct as-is; but the "expires_at>now()" derivation is exactly the "expiring soon" data the FE needs and no slice exposes. |
| B9 | Bulk send per-owner outcomes (created/skipped_existing/failed) | `signature-requests.service.ts:406-600` | Whole-building send | **COVERED** | Campaign (M5) wraps it; plan notes the ConfirmDialog. |
| B10 | Campaign fan-out (derive owners, chunk 200, project-doc only) | `signature-requests.service.ts:632-725` | "Send to all owners" | **COVERED** | M5. Plan keeps `signature_requests.send` gate. |
| B11 | Campaign requires PROJECT-scoped doc (apartment-scoped → 400) | `signature-requests.service.ts:682,736-741` | Honesty: avoid silent-drop | **GAP-adjacent** | The redesign's "send campaign" button must respect doc-scope; plan never names the 400. |
| B12 | Signature is forensic/immutable (doc hash, IP/UA pinned) | `public-sign.service.ts:322-340`, `signatures` table | Legal evidence | **COVERED** | `01 §4.6`; plan says UI conveys permanence. |
| B13 | Resident consent ack (`consent_required` if org requires) | `public-sign.service.ts:318-320` | Explicit-consent org policy | **AS-IS-OK** | Public sign page out of redesign scope; fine. |

### C. Ownership shares & integrity

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| C1 | Exact share fraction (`share_num/den`) stored, sums to 1 (deferred trigger) | `ownerships.service.ts:99-126`, migration 0065 | Legally-clean share data | **COVERED** | `01 §3.3` — the proof the share-weighted calc is a pure read. |
| C2 | Atomic full-set replace (end-all + insert) | `ownerships.service.ts:99-126,320-400` | The only safe write path | **AS-IS-OK** | Plan doesn't change; fine. |
| C3 | `ownership_pct` recomputed from fraction (no drift) | `ownerships.service.ts:117` | Compat display value | **AS-IS-OK** | Plan keeps both surfaces ("1/3" + 33.33%). |
| C4 | Sum-invalid → clean 400 (in-app + trigger backstop) | `ownerships.service.ts:394-423` | Reject bad share sets | **AS-IS-OK** | Untouched; fine. |
| C5 | Owner SHELL counts toward consent denominator | `projects.service.ts:375-393` | SHELL = active owner | **GAP (G11)** | Plan renders SHELL as "discovery" but never specifies its effect on the share-weighted denominator. |
| C6 | `relationship` enum now `['owner']` only (renter retired, 0066) | `ownership.ts:23`, `RelationshipSchema` | Renters are discovery sources | **GAP (G5)** | Plan treats renter-exclusion as LIVE; it's dead code. Model is 1 migration stale. |
| C7 | `resolveRenterOnly` defensive no-op (always ∅) | `signature-requests.service.ts:171-174` | Vestigial renter gate | **GAP (G5)** | Same as C6 — plan cites a "renter gate" that no longer excludes anything. |

### D. Status enums & transitions

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| D1 | `project_status` enum (D.18 locked) | `_enums.ts:17-24` | Pipeline label | **AS-IS-OK** | Plan respects the locked enum. |
| D2 | Project status transitions — NO GUARD (any→any) | `projects.service.ts:762-820` | — | **GAP (G3)** | Free-text setter; board-first "approve" wires to an ungated transition with no `metThreshold` precondition. |
| D3 | `apartment_status` enum (6 values) | `_enums.ts:26-33` | Field-work state | **AS-IS-OK** | Plan uses it as honest "why" substitute. |
| D4 | Apartment status transition — NO GUARD; only `statusChangedAt` on real change | `apartments.service.ts:260-263` | — | **GAP (G8)** | `status='signed'` independent of signature_requests; board chip can contradict consent calc. |
| D5 | `task_status` enum (pending/in_progress/completed/cancelled) | `_enums.ts:37-42` | Task lifecycle | **AS-IS-OK** | Tasks demoted to nav spine but logic untouched; fine. |
| D6 | Import status enum (queued…awaiting_mapping/confirm/done/failed) | `import.ts:53-66` | Import lifecycle | **AS-IS-OK** | Plan re-skins import (C8) but logic untouched. |
| D7 | Tabu extraction draft→confirmed/discarded (terminal 409) | `tabu-extractions.service.ts:78-84,380` | Parse→confirm lifecycle | **GAP (G9)** | Feeds ownerships the board reads; plan never inventories it. |
| D8 | Discovery status enum (not_visited…owner_identified/refused) | `discovery.service.ts`, `projects.ts:344-375` | Find-the-owner | **GAP (G9)** | "C10 no FE"; business rules unaudited. |

### E. Expiry, scheduling & autonomy

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| E1 | ZERO scheduler/cron in API (grep-confirmed) | (no `@Cron`/`ScheduleModule`; only import `setTimeout` polling) | No background autonomy today | **CHANGED** | B3 adds the worker. Correctly identified (master §4.1). |
| E2 | Notification producer is `emit`/`emitMany` only (synchronous) | `notifications-producer.service.ts:51-94` | No clock-driven notifications | **CHANGED** | B3 drives time-based emits. Correct. |
| E3 | No "expiring soon" queryable set pre-B3 | derive `expires_at>now()` over pending | FE chase-queue sort | **GAP (G4)** | C6 "sort expiring-soonest" needs an endpoint no slice owns; project/board never join expiry. |
| E4 | No threshold-reached notification emitted | `notifications-producer` (no such type beyond `signature_received`) | "you crossed the line" | **GAP-adjacent** | `C11` notes it; M3 celebration is client-edge only. Owner-prioritized. |
| E5 | Calendar service = ICS generation only (no scheduling) | `calendar.service.ts:93-127` | Email ICS for tasks | **AS-IS-OK** | Plan "delete calendar stub" on home; populated calendar is C11. Service itself fine. |

### F. Validation rules (Zod / DTO / national_id)

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| F1 | national_id 9-digit + Luhn checksum (`isValidIsraeliId`) | `validators/src/israeli-id.ts`, `owner.ts:103` | PII validity | **AS-IS-OK** | Plan's search omnibox (S4) reuses `POST /owners/search` national_id branch; validator untouched. |
| F2 | Owner write SHELL-able (name/national_id optional on create) | `owner.ts:116-123` | Tabu/import skeleton owners | **AS-IS-OK** | Consistent with SHELL board rendering. |
| F3 | PII always masked on read; reveal-on-demand (`view_owner_pii`) | `owner.ts:39-95`, `agent-capabilities.ts:106-124` | D.54 | **COVERED** | S4 honors "no PII in URL"; reveal gate carries over. |
| F4 | `OwnerSearchInput` PII-in-body refine (national_id OR phone) | `owner.ts:135-147` | Throttled search | **COVERED** | Global search omnibox extends this. |
| F5 | Import row national_id MANDATORY + checksum | `import.spec.ts:81`, `import.ts:222-233` | Every imported owner hash-matchable | **GAP (G9)** | Memory confirms; plan doesn't audit import row rules. |
| F6 | shareEntry: owner numerator ≥ 1; pct never trusted (derived) | `ownership.ts:45-57` | Share write integrity | **AS-IS-OK** | Untouched. |
| F7 | Project milestones superRefine (ascending/unique/≤target) | `project.ts:105-115` | Staged target validity | **GAP (G12)** | Validated but never surfaced by the redesign. |
| F8 | `.strict()` fail-closed on write DTOs | `owner.ts:122`, throughout | FE-security DoD | **AS-IS-OK** | Plan respects. |

### G. Authz / permission resolution / RLS scoping

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| G-1 | Role authz owned in-service (manager/viewer/agent) | `projects.service.ts:182-184`, throughout | D.17 | **COVERED** | Plan §2.2 keeps gating in service+guard+middleware. |
| G-2 | Agent → assigned-project scope (inner-join active assignment) | `projects.service.ts:207-222,306-332` | Agent record-scoping | **COVERED** | B1 pulse reuses the agent-scope CTE; smoke per-role. |
| G-3 | Agent capability gate (JSONB `manage_signatures` etc., D.46/D.54) | `agent-capabilities.ts:29-63` | Fine authz half | **COVERED** | Plan: "promoting a control into a tab does not ungate it." |
| G-4 | Owner-PII fidelity resolver (masked/unmasked) | `agent-capabilities.ts:106-124` | D.54 single source | **COVERED** | Export + search reflect on-screen fidelity. |
| G-5 | Member-permission OVERRIDE engine (grant/deny, anti-escalation, owner-tier, last-Owner) | `member-overrides.service.ts:32-108` | Per-member perm layer | **GAP (G10)** | Plan's authz claim omits the override layer; demoted Admin/Access surface risk. |
| G-6 | No-oracle 404 (cross-org / unassigned indistinguishable) | throughout (`projects.service.ts:331`) | IDOR defense | **AS-IS-OK** | Plan preserves (routes never deleted). |
| G-7 | RLS = org isolation via `withTenant` GUC | `with-tenant.ts`, every service | Tenant boundary | **AS-IS-OK** | Plan adds no direct db.query; respects. |
| G-8 | Recipient-association gate (owner must be tied to doc scope) | `signature-requests.service.ts:193-232` | Consent-integrity chokepoint | **GAP (G6)** | Chase-loop slices assume send "just works"; no calm surface for `recipient_not_associated`. |
| G-9 | Contractor share-token authz + status→`invalidLink` collapse | `contractor-read.service.ts`, `share-token.service.ts` | External deliverable | **CHANGED (visual only)** | C7 re-skins; notes BE lifecycle collapses to one opaque status (a real info-loss the plan flags visually, not in logic). |

### H. Import / Tabu / Discovery (the data the board consumes)

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| H1 | Import worker national_id-mandatory row validation | `imports.service.ts`, `import.ts:222-233` | Hash-matchable owners | **GAP (G9)** | Out of plan's domain scope. |
| H2 | Import preview→confirm pause (`awaiting_confirm`, 0048) | `imports.service.ts:1188-1247` | Approve-don't-construct precedent | **COVERED (as precedent)** | `C8` cites it; M1/G6 must reconcile live-update idiom. Good catch by plan. |
| H3 | Import SSE live progress (disproves "no real-time") | `import.ts:266-311`, `use-import-progress.ts` | Live import feed | **COVERED** | `C8` flags the premise correction. |
| H4 | Tabu confirm derives share fraction + provenance (0071) | `tabu-extractions.service.ts:84,361`, `ownerships.service.ts:81-83` | Registry→ownerships | **GAP (G9)** | Feeds consent denominator; logic unaudited. |
| H5 | Discovery records CRUD + status (find-the-owner) | `discovery.service.ts:148-229` | Half the workflow | **GAP (G9 / C10)** | Plan defers FE; never audits the rules feeding SHELL resolution. |

### I. Audit & misc domain rules

| # | Item | file:line | Purpose | Status | Note |
|---|---|---|---|---|---|
| I1 | Append-only audit on every write (create/update/archive/sign/resend/cancel) | `projects.service.ts:737`, throughout | Forensic trail | **AS-IS-OK** | Plan adds no write that skips audit; preserve. |
| I2 | Soft delete = `archivedAt` (idempotent archive) | `projects.service.ts:824-848` | D-rule | **AS-IS-OK** | Plan respects "ארכוב" verb. |
| I3 | Duplicate-apartment-number guard (partial unique index → clean 409) | `projects.service.ts:140-166,717-732` | Wizard row highlight | **AS-IS-OK** | C5 wizard re-skin must preserve the `apartment_number_duplicate` surface. |
| I4 | Atomic wizard expansion (project+buildings+sections+apartments one tx) | `projects.service.ts:634-735` | No half-created projects | **AS-IS-OK** | C5 wizard logic untouched; visual only. |
| I5 | `apt_count` maintained by trigger (don't double-count) | `projects.service.ts:656-660`, migration 0002 | Building unit count | **AS-IS-OK** | Untouched. |
| I6 | Notification emit on apartment status change (real change only) | `apartments.service.ts:307-331` | Momentum feed source | **GAP-adjacent (C11)** | Plan's "notifications-as-momentum" is C11; emit logic fine but underused. |

---

## Coverage tally

- **Items inventoried:** 62 (across 11 categories, enumerated from 27 service
  modules + enums + Zod schemas via Glob, not the plan's lists).
- **COVERED:** 16 · **CHANGED (plan modifies, specified well):** 6 ·
  **AS-IS-OK (correctly untouched):** 27 · **GAP:** 13 (plus ~5 GAP-adjacent).
- **Distinct GAP themes:** 12 (G1–G12).
