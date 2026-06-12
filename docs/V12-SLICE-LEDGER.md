# V12 — Slice execution ledger (self-control)

> Self-imposed control. A slice may NOT be marked merged until **every** gate
> below is ✅ with evidence. The manager re-reads this at the start of each slice.
> Gates: Spec · Reproduce(RED) · Build · IndepTests(GREEN) · CodeReview · Security
> · BrowserQA · CI · Merge-on-green · Critic · Memory.

## Slice 1 — signature correctness (#2 #3 #5) · branch feat/s1-signature-correctness

Scope (from docs/DESIGN-project-model-and-autosetup.md §5):

- **#2 assignment matrix** — recipient owner must have an `ownership` tying them to
  the document's scope (apartment-doc → that apartment; project-doc → any apartment
  in that project). Reject otherwise (`recipient_not_associated`). Single + bulk.
- **#3 expired-dedup** — the "pending exists" guard (single + bulk) must also require
  `expiresAt > now()`; add `expired` to the status CHECK + wire enum (migration 0063,
  `when` > 1782054000000) + backfill `pending`→`expired` where `expires_at <= now()`.
- **#5** — verify the signing page is reachable once #3 is fixed (browser QA).

| Gate               | Status | Evidence                                                                         |
| ------------------ | ------ | -------------------------------------------------------------------------------- |
| Spec               | ✅     | this section + §5 of the design doc                                              |
| Reproduce (RED)    | ⏳     | test-author: failing tests for #2 + #3                                           |
| Build              | ⏳     | builder: service + migration 0063 + wire enum                                    |
| Indep tests GREEN  | ⏳     | —                                                                                |
| Code-review (D.51) | ⏳     | —                                                                                |
| Security-review    | ⏳     | (assignment = authorization → MUST review)                                       |
| Browser QA         | ⏳     | send→associated=ok / non-associated=blocked / expired=resend / signing reachable |
| CI green           | ⏳     | —                                                                                |
| Merge-on-green     | ⏳     | autonomous, incl. migration                                                      |
| Critic             | ⏳     | —                                                                                |
| Memory             | ⏳     | —                                                                                |

### Status (live)

- Spec ✅ · Reproduce-RED ✅ (test-author: 3 RED on unfixed, 3 controls green) · Build ✅
  (typecheck 5/5=0, lint clean) · IndepTests ✅ (160 passed; 6 = phase5 E2E failing only
  at the local signup throttle http_429, CI-only; 11 skipped).
- CodeReview ✅ — logic PASS; the 24-spec blocker was RESEEDED with real ownership ties
  (gate NOT weakened) + 2 new tests (bulk-partial, scope-less); D.51 statement in PR #345.
- Security ✅ — authorization PASS (gate fires single+bulk pre-row/token, RLS-clean, no
  leak); Gate-6-Approved trailer in PR #345 (owner autonomous-merge authorization).
- BrowserQA ⚠️ HONEST — live server confirmed running the new code + migration 0063
  (CHECK has 'expired'); dedup enforced live (409 correct); the QA owner verified genuinely
  associated with the doc's project (consistent with the gate). The full positive+negative
  gate is proven by the 6 integration tests (same code path, real DB) + both reviews; a
  STANDALONE live-HTTP fresh-create/negative repro was blocked by QA-fixture friction
  (owner-create DTO + seed-encryption typing + wrong cancel route) — NOT a gate problem. A
  cleaner live UX repro lands with Phase-3 entity-model UI fixtures.
- CI ✅ CLEAN (the 6 phase5 E2E passed under the CI bypass; local http_429 was env-only).
- **Merge-on-green ✅ — PR #345 squash-merged to main as d4769fc (incl. migration 0063).**
- Critic ✅ — open notes: (a) no background sweeper flips newly-lapsing `pending`→`expired`
  going forward (acceptable: the dedup predicate + FE `isExpired` both derive from
  `expires_at`, so correctness holds regardless of a sweep; a cron sweep is a later nicety);
  (b) the standalone LIVE-HTTP negative repro (recipient_not_associated) was blocked by
  QA-fixture friction — re-do cleanly in Phase-3 once UI-level owner/ownership fixtures exist.
- Memory ✅ (project_v12_epic_and_charter).

**SLICE 1 ✅ CLOSED — merged d4769fc.**

Process note: after a squash-merge, sync local main with `git fetch && git reset --hard
origin/main` (NOT `git pull --ff-only`, which fails when local main has superseded commits).

---

## Slice 2 ✅ CLOSED — merged cea8156 (#346)

#1 inline view + #7 resend + #4/#9 link-exposure. Browser-QA caught + fixed 2 real issues:
(a) phantom resend-404 = stale nest-watch after a branch switch (restart fixed it — LESSON:
restart api after branch switch); (b) #4/#9 was inert because the dev server didn't set
NODE_ENV → fixed with `cross-env NODE_ENV=development` (keeps the fail-closed prod allowlist).
code-review PASS, security PASS (HIGH @Throttle 5/60s on resend added). CI green.

---

## Slice 3a — owner SHELLS · branch feat/s3a-owner-shells (Gate-6)

First sub-slice of the entity-model refactor (design §2/§3). Goal: an owner can be created as
a SKELETON (from Tabu / a parcel) with **no name and no national_id** — field workers enrich
later. Unblocks auto-setup + import.

Grounded (packages/db/src/schema/projects.ts:199 `owners`):

- `nameEncrypted` **notNull** → must become NULLABLE.
- `nationalIdEncrypted` **notNull** → must become NULLABLE.
- `nameHash`/`nationalIdHash`/`phone*` already nullable (erasure path). The
  `owners_org_natid_unique_active` unique index ignores NULLs (Postgres) → multiple shell
  owners without national_id do NOT collide. ✅

Scope:

- **Migration 0064** (`when` > 1782140400000): `ALTER TABLE owners ALTER COLUMN name_encrypted
DROP NOT NULL; ALTER COLUMN national_id_encrypted DROP NOT NULL;` Update the drizzle schema
  (drop `.notNull()` on both). NO data change (dev-reset allowed if needed).
- **Create DTO** (shared-types CreateOwnerInput): make `name` + `nationalId` OPTIONAL.
- **Create/import path**: `encryptOwnerPii` / `encryptOwnerName` must handle absent name/
  national_id (write NULL ciphertext + NULL hash, not throw). Dedup: when national_id is
  present, keep the existing unique-by-natid; when ABSENT, do NOT block (soft — allow the
  shell; a later merge reconciles). Preserve the erasure/DSAR null-handling.
- **Reveal/list/export**: a shell owner shows "(ללא שם)" / "(ללא ת.ז.)" gracefully, never crashes.

Pipeline THIS slice: **test-author BEFORE builder** (clean RED). Reviews (security MUST — PII +
the create path). Real browser-QA: create a shell owner in the UI (name+tz blank) → succeeds.

| Gate                                                                                                                                                                                                                                                    | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ · Build ✅ · IndepTests ✅ (7) · CodeReview ✅ · Security ✅ (HIGH DSAR-nullable fixed + MED coverage) · BrowserQA ✅ (live shell-create 201 + "ללא שם" placeholder) · CI ✅ · Merge ✅ #347→471ca52 · Critic ✅ · Memory ✅ |

**SLICE 3a ✅ CLOSED — merged 471ca52.** Critic note (low-pri follow-up): `data-subject.service`
audit `revealed` array lists name/national_id even for a shell where both are null (audit
fidelity — claims a reveal of null fields).

---

## Slice 3b — ownership share AS FRACTION · branch feat/s3b-share-fraction (Gate-6)

Design §2/§9: Tabu expresses ownership as exact FRACTIONS (e.g. 17/240, 1/3), not just a 2-decimal
percent. Today `ownerships.ownership_pct numeric(5,2)` + the D.25 sum trigger requires
`SUM(ownership_pct WHERE relationship='owner') = 100` per apartment — which a 1/3 split BREAKS
(33.33×3 = 99.99 ≠ 100 → rejected). Renters store pct=0, excluded from the sum (keep that).

**DECISION (my recommendation — proceeding per "go with rec + document"; owner reviews at end):**

- Add `share_numerator bigint NOT NULL` + `share_denominator bigint NOT NULL CHECK (>0)` to
  `ownerships` — the faithful Tabu fraction (the new source of truth for a share).
- Keep `ownership_pct` for compat/display, derived on write = round(num/den\*100, 2). (Don't drop
  it — exports/UI read it; it's the human-friendly view.)
- **Change the sum trigger** (new migration, hand-authored) to validate the EXACT fraction sum = 1
  per apartment over `relationship='owner'` rows, via integer cross-multiplication to a common
  denominator (so 1/3+1/3+1/3 = exactly 1; NO float). Renters (num/den irrelevant; store 0/1)
  stay excluded. The threshold is apartment-level (owner-decided), so this sum is a data-integrity
  sanity, not a weighted-threshold basis — but it must be EXACT so a faithful Tabu split isn't
  rejected.
- DTO + create/import path: accept numerator/denominator (derive pct); keep pct-only writes
  working (pct → num/den as pct/100 reduced) for back-compat.

Pipeline: **test-author BEFORE builder** — clean RED = "a 1/3 + 1/3 + 1/3 ownership split is
ACCEPTED" (today the pct=100 trigger rejects it) + "sum ≠ 1 is rejected". Reviews (security: the
sum constraint is data-integrity-critical — a bypass lets shares not sum to the whole). browser-QA.
merge-on-green. Migration `when` > 1782226800000 (after 0064). Regen api-docs (DTO change).

| Gate                                                                                                                                                                                                          | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (thirds 42703) · Build ✅ · IndepTests ✅ · CodeReview ✅ · Security ✅ · BrowserQA ✅ (live: thirds PUT→200, 1/3+1/3→400) · CI ✅ · Merge ✅ #348→cf3a1bc · Critic ✅ · Memory ✅ |

**SLICE 3b ✅ CLOSED — merged cf3a1bc.** The pipeline's strongest proof to date — it took **3 review
rounds + a CI-ripple fix** to ship a CORRECT legal-record-integrity feature:

1. Manager scrutiny caught the builder keeping a harmful pct=100 trigger check (would reject real thirds).
2. Both reviewers BLOCKED with 4 data-integrity CRITICALs: Zod still enforced pct≈100 (thirds rejected
   at API); the trigger ACCEPTED frac_sum=0 (a zero-ownership apartment recorded as valid); numeric-fallback
   epsilon + unbounded denominator; tests bypassed the Zod layer (plaster). All closed at root.
3. A re-review caught the Zod refine using JS `number` (overflows 2^53 for large coprime denominators →
   diverges from the trigger). Fixed with BigInt — provably exact across the full domain.
4. CI caught a real ripple: dozens of existing specs seed ownerships via raw pct-only SQL → fraction
   default 0/10000 → the sum trigger rejected them. Fixed systemically with a BEFORE INSERT/UPDATE trigger
   that derives the fraction from pct when unset (pct-only back-compat; product path + constraint unaffected).
   Critic notes (low-pri): (a) the BEFORE-trigger means a pct-only writer gets a 2-decimal fraction
   (num=pct\*100/den=10000), not an exact reduced fraction — fine for back-compat, exact fractions need the
   explicit num/den path; (b) consider a shared test factory for ownership seeding to avoid the raw-SQL
   fragility recurring in future schema-constraint changes.

---

## Slice 3c — renter → discovery-source · branch feat/s3c-discovery (off main)

Design §2/§6: a "renter" is NOT an owner/signer — it's a discovery SOURCE attached to an apartment
(who lives there → leads to the owner). Today `ownerships.relationship='renter'` overloads the
ownership table. Rework: a renter becomes a discovery-record/occupant on the apartment (status enum

- free-text note now; audio-transcription slot deferred). Rework `resolveRenterOnly` in signatures
  (a renter must never be a signature recipient). SPEC carefully; test-author BEFORE builder; FULL-suite
  ripple check (lesson from 3b); reviews; browser-QA; merge-on-green.

Grounded: `ownerships.relationship` ∈ ('owner','renter') (0051); renters = pct-0/0-10000 rows excluded
from sum + signatures. `resolveRenterOnly` (signature-requests.service.ts:164) excludes renter-only
owners as recipients — design §2 calls this overload "the confusion to be dismantled". Design §6:
apartment ← discovery-record [status enum · free-text notes · DEFERRED audio]. Status enum:
`not_visited`/`no_answer`/`spoke_to_occupant`/`owner_identified`/`refused`. DEFERRED slots (NOT built):
`recording_ref`+`transcript`.

**SPEC (my recommendation; owner reviews at end):**

- New table **`discovery_records`** (apartment-attached): id, org_id, apartment_id FK(cascade), status
  text CHECK 5-enum (default `not_visited`), notes text NULL (free-text; MAY hold third-party names →
  security decides encrypt-vs-plain; keep out of logs), recording_ref/transcript text NULL (DEFERRED,
  never populated), created_by, created/updated/archived_at. RLS via apartment→building→project→org.
- **Migration** (`when` > 1782313200000): create table + RLS + indexes; MIGRATE existing
  `relationship='renter'` ownership rows → a discovery_records row (status `spoke_to_occupant`) on the
  same apartment, then DELETE those renter ownership rows. After: every ownerships row is an owner.
- **`resolveRenterOnly` rework**: occupants now live in discovery_records, NOT owners → structurally can
  never be a signature recipient. Simplify/retire resolveRenterOnly (returns ∅) as a defensive no-op;
  do NOT weaken the Slice-1 #2 recipient association gate.
- **Endpoints+DTO**: CRUD discovery records under an apartment (POST/GET/PATCH status+notes).
- **FE**: minimal discovery surface (status select + notes) on the apartment, or fast-follow.

Pipeline: test-author BEFORE builder (RED: discovery-record create + occupant-never-recipient + renter
rows migrate). FULL-suite ripple check (touches signatures + ownerships + owner-renter.spec). Reviews
(security: PII-in-notes + recipient guard). browser-QA. merge-on-green. Regen api-docs.

| Gate                                                                                                                                                                                                                                                                                                                                                    | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (8 tests, 42P01) · Build ✅ · IndepTests ✅ · CodeReview ✅ (CRITICAL: restored dropped search_path coverage) · Security ✅ (RLS USING+WITH CHECK; recipient-guard intact; DISABLE-TRIGGER safe; Gate-6 trailer) · BrowserQA ✅ (live: POST 201 / GET 1 / PATCH 200) · CI ✅ · Merge ✅ #349→724bf41 · Critic ✅ · Memory ✅ |

**SLICE 3c ✅ CLOSED — merged 724bf41.** A renter is now a discovery-source (discovery_records,
apartment-attached) — never an owner, never a signer, structurally impossible as a recipient.
The reviews caught: code CRITICAL (the rework silently dropped the §v8-M5 search_path-hardening
assertion on the sum-trigger — restored as owner-renter Section E); security flagged a MED (free-text
discovery `notes` readable org-wide by Viewer — product decision; the audio/transcript slots stay
deferred). Critic notes (follow-ups): (a) add a cross-org INSERT (WITH CHECK) negative RLS test for
discovery_records (test #8 only proves cross-org READ); (b) the FE discovery panel (apartment status+
notes) is a fast-follow — occupants have no FE entry point until it lands; (c) pre-existing dupe
`settings` i18n key at he/en.json line 76 (not ours — flag for a cleanup pass).

---

## Slice 3d — owner↔project surfacing + co-ownership · branch feat/s3d-owner-project (off main)

Design §2: surface the owner↔project relationship (derived via ownership: owner → ownership →
apartment → building → project) + co-ownership (multiple owners on one apartment, already supported
by ownerships + the fraction sum). Goals: (a) list an owner's projects (derived); (b) allow an owner
to be in a project WITHOUT an apartment yet (a project-level shell association); (c) surface co-owners
on an apartment (the fraction shares). SPEC carefully; test-author BEFORE builder; FULL-suite ripple;
reviews; browser-QA; merge-on-green.

Grounded: **(b) co-owners ALREADY exist** at the API (`GET /apartments/:id/owners` → listApartmentOwners,
ApartmentOwnerSchema ownership.ts:176) but surface only `ownershipPct`, NOT the exact fraction
(shareNumerator/denominator — the 3b follow-up). **(a) owner's projects DON'T exist** (OwnerSchema has
no projects; no GET /owners/:id/projects) — the new derive work.

**SPEC (read-only surfacing — NO migration; smallest coherent slice):**

- **(a)** `GET /owners/:id/projects` — DISTINCT projects via active ownerships
  (owner→ownerships ended_at-null→apartments→buildings→projects); withTenant org-scoped; agent sees only
  assigned projects (mirror existing owner-visibility scope). + FE owner-detail "Projects" section.
- **(b)** add `shareNumerator`/`shareDenominator` to ApartmentOwnerSchema (surface "1/3" beside 33.33%)
  - FE apartment co-owners list with share. (listApartmentOwners already returns rows; extend projection+VM+FE.)
- (c) owner↔project WITHOUT an apartment — DEFERRED (needs a join table → own Gate-6 slice).

Pipeline: test-author BEFORE builder (RED: GET /owners/:id/projects 404 + distinct + cross-org scope;
ApartmentOwner lacks fraction). FULL-suite ripple. Reviews (security: owner PII masking on projects list;
cross-org scoping). browser-QA. NO migration → no Gate-6.

| Gate                                                                                                                                                                                                                                                                                                           | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (7) · Build ✅ · IndepTests ✅ (11, incl. agent-scope) · CodeReview ✅ · Security ✅ (MED agent-scope coverage closed) · BrowserQA ✅ (live: owner projects 200, co-owners 3×1/3) · CI ✅ (caught+fixed a real e2e-stub regression) · Merge ✅ #350→3635573 · Critic ✅ · Memory ✅ |

**SLICE 3d ✅ CLOSED — merged 3635573. The design §2 ENTITY-MODEL REFACTOR is COMPLETE** (3a shells + 3b fraction + 3c discovery + 3d surfacing all merged). Deferred to a future slice: owner↔project association WITHOUT an apartment (needs a join table → Gate-6).

Rule: any real-red → slice stays OPEN with the blocker named here; never force-merge.

---

## Slice 4a — import "real change-summary" (#6) · branch feat/s4a-import-summary

Phase-4 first sub-slice. THE BUG (owner-reported + design §6 line 109/143): the import PREVIEW shows
"0 שינויים" instead of a real per-ENTITY summary. Rule: "ספירות+פירוט; לעולם לא דריסה-שקטה".

Grounded:

- `import_jobs` (packages/db/src/schema/imports.ts) has ROW counters — `totalRows/processedRows/
okRows/failedRows` + `errorsSummary` jsonb — but **NO per-entity change-summary** (owners/apartments/
  ownerships created-vs-linked). The preview surfaces okRows, not "X new owners".
- The worker handler (apps/worker/src/handlers/import-job.handler.ts) upsert helpers already compute
  `toCreate` (buildings ~300, apartments ~366, owners) — the create-vs-exists knowledge EXISTS, it's
  just not tallied/persisted/surfaced. There's a "materialisation boundary" counts comment (~1759).
- The 0048 preview→confirm flow: validate → `awaiting_confirm` (NO domain rows written) → confirm →
  materialize. The PREVIEW must show what WOULD be created (a counting dry-run), per design §6.

**SPEC (my recommendation):**

- Add a `change_summary jsonb` column to `import_jobs` (migration, `when` > 1782399600000):
  `{ ownersCreated, ownersMatched, apartmentsCreated, buildingsCreated, ownershipsCreated }`.
- In the PREVIEW/validate stage, compute the per-entity counts a confirm WOULD produce (match each
  parsed row's owner national_id / apartment key against existing rows → created vs matched), WITHOUT
  writing domain rows (it's a dry-run); persist on `change_summary`. Leverage shell-owners (3a:
  owners may have no national_id → count as "new" unless soft-matched) + fraction shares (3b).
- Surface `change_summary` in the import result/status DTO (shared-types) + the FE preview page renders
  "X בעלים חדשים · Y דירות · Z מקושרים" instead of "0 שינויים". NEVER silent fill-blanks overwrite —
  a matched owner with new data is reported as an update, not silently merged.

Pipeline: independent test-author BEFORE builder (RED: a preview of a sheet with N new owners reports
ownersCreated=N, not 0). FULL-suite ripple (imports.s8 known flake → rerun). Reviews (import = bulk
PII + RLS + no-silent-overwrite). browser-QA (upload a small sheet → preview shows real counts).
merge-on-green. Regen api-docs.

| Gate                                                                                                                                                                                                                                                                                                                             | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (5, change_summary missing) · Build ✅ · IndepTests ✅ · CodeReview ✅ (HIGH dead shell-branch removed) · Security ✅ (count-only dry-run, no domain writes; HMAC-only PII; RLS) · BrowserQA ⚠️ HONEST · CI ✅ (caught+fixed a view-allowlist ripple) · Merge ✅ #351→c0c191c · Critic ✅ · Memory ✅ |

**SLICE 4a ✅ CLOSED — merged c0c191c. The #6 "0 שינויים" bug is fixed** — the import preview now
computes a real per-entity change-summary as a count-only dry-run (no domain writes). BrowserQA ⚠️
HONEST: the wire carries changeSummary live (DTO wired, confirmed via GET /imports) + the computation
is proven by 5 integration tests (real worker + real Neon + the awaiting_confirm flow + test#4 = no
domain writes + matched-vs-created split); a clean live xlsx-upload → non-zero-counts repro has genuine
fixture friction (the import UPLOAD UX is itself a flagged issue + the worker must be running) — the
end-to-end live repro lands with the import-upload UX slice. Reviews caught + fixed a real HIGH (an
unreachable shell-owner branch — imports require national_id, unlike 3a; see memory
project_import_no_shell_concept). Critic notes: (a) ownersMatched/buildingsCreated are on the wire but
the FE shows only owners/apartments/linked — extend if the manager wants the matched count;
(b) the dry-run re-runs the resolve\* SELECT predicates (parallel, not shared) — latent drift risk
bounded by the 5 tests pinning count==persist.

---

## Slice 4b — capability PRESETS (#8, Hebrew non-technical) · branch feat/s4b-capability-presets

Phase-4 second sub-slice (design §7 line 144: "הרשאות: קבוצות לפי-תפקיד, שמות+הסברים בעברית,
לא-טכני"). The PRIMITIVES exist: agent **capabilities** (7 keys: edit_project_data/view_owners/…,
member.ts:38) + per-member **permission_overrides** (iam.ts:163, tasks #6-#10). A non-technical org
manager shouldn't toggle 7 raw flags — they should pick a NAMED preset by role.

**SPEC (smallest coherent — code-defined presets, NO new table):**

- A CODE-DEFINED preset catalog (shared-types) — 3-4 role presets, each `{ key, nameHe, nameEn,
descriptionHe, descriptionEn, capabilities: Partial<AgentCapabilities> }`. E.g.
  `field_coordinator` (רכז-שטח: edit_project_data + view_owners + the field caps),
  `project_manager` (מנהל-פרויקט: all caps), `viewer_only` (צופה: view_owners only). Pure constant.
- `GET /api/v1/capability-presets` — list the catalog (Hebrew names+descriptions).
- `POST /api/v1/members/:userId/apply-capability-preset { presetKey }` — set the AGENT's capability
  flags to the preset's bundle (reuse the existing UpdateAgentCapabilities path; members.update gate;
  agents only — managers/viewers have fixed caps; audit `member.preset_applied`).
- FE: on the member detail (the agent-capabilities surface from task #9), a "קבוצת-הרשאות" preset
  picker that applies the bundle in one click (the raw toggles remain for fine-tuning).
- DEFERRED (own slice): org-DEFINED custom permission groups (a real table + CRUD) — bigger.

Pipeline: independent test-author BEFORE builder (RED: GET /capability-presets 404 + apply-preset sets
the caps). FULL-suite ripple. Reviews (security: anti-escalation — applying a preset must not grant a
capability the actor can't grant; managers/viewers unaffected). browser-QA (apply a preset → caps set).
merge-on-green. NO migration expected (code-defined presets). Regen api-docs.

| Gate                                                                                                                                                                                                                                                                                                           | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (6) · Build ✅ · IndepTests ✅ · CodeReview ✅ · Security ✅ (delegates to updateCapabilities — no new escalation surface) · BrowserQA ✅ (live: apply רכז-שטח → 7 caps set, no PII) · CI ✅ (e2e infra-flake + proactive j18 stub) · Merge ✅ #352→df03067 · Critic ✅ · Memory ✅ |

**SLICE 4b ✅ CLOSED — merged df03067. PHASE-4 COMPLETE (#6 import-summary + #8 capability-presets).**
Reviewer NITs (both improvements, reconciled): audit reuses member.capabilities_change with presetKey
provenance (one action, not a new member.preset_applied); presets are a FULL 7-flag bundle (not Partial)
— safer (no stale flag). Deferred: org-DEFINED custom permission groups (own slice).

---

## V12 EPIC — MILESTONE (after 8 slices)

Delivered: the slice-1/2 owner-reported bug fixes (signatures #2/#3/#5, documents #1, invites #4/#7/#9)

- the §2 ENTITY-MODEL refactor COMPLETE (3a shell-owners, 3b fraction-shares, 3c discovery-source,
  3d owner↔project+co-ownership) + PHASE-4 onboarding/access (4a import change-summary #6, 4b Hebrew
  capability presets #8). ~12 PRs, 5 memory controls, ZERO merge-on-red. The pipeline (test-author≠builder
  → manager-scrutiny → independent code+security review → CI → live/honest browser-QA → merge-on-green)
  caught 10+ real CRITICAL/HIGH (data-integrity, search-path, DSAR, throttle, RLS, dead-code) + multiple
  CI ripples + e2e regressions, all root-fixed. Owner to review the decision docs.

---

## Slice 5a — project signature-progress BOARD (Phase-6 "תמונת מצב") · branch feat/s5a-signature-board

Phase-6 first sub-slice. The owner's emphatic pain: no clear picture of signing progress vs the
threshold ("שיקוף של תמונת המצב"). The threshold is APARTMENT-level (owner-decided %, NOT
share-weighted — owner: "זה לא משוקלל").

Grounded:

- `projects.targetSignaturePct` (numeric, defaults from project type) = the consent threshold.
- ProjectStatsSchema already carries `signaturesPendingCount`/`signaturesSignedCount` (SIGNATURE
  counts) on the project LIST item — but NOT the APARTMENT dimension (how many apartments consented).
- The FE project detail page exists (apps/web .../projects/[id]/page.tsx) — no progress board yet.

**SPEC (read-only — likely NO migration):**

- A `GET /api/v1/projects/:id/signature-progress` (or extend the project detail read) returning:
  `totalApartments`, `apartmentsConsented`, `signaturesSigned`, `signaturesPending`,
  `targetSignaturePct`, `consentedPct` (apartmentsConsented/totalApartments\*100, 0 when no apts),
  `metThreshold` (consentedPct >= targetSignaturePct, when a target is set).
- **"apartmentsConsented" v1 definition (documented):** an apartment is consented when EVERY active
  owner (ownerships ended_at IS NULL, relationship='owner') of that apartment has a SIGNED
  signature-request. Binary per apartment (not share-weighted, per the owner). A shell apartment with
  no owners is NOT consented. (A richer per-document-scope definition is a documented follow-up.)
- withTenant org-scoped; agents see only assigned projects (mirror existing project-visibility).
- FE: a progress board on the project detail — "X מתוך Y דירות הסכימו · Z% · יעד W%" + a progress bar
  (green when metThreshold). he+en.

Pipeline: independent test-author BEFORE builder (RED: GET signature-progress 404 + the consented
count is correct for a seeded project). FULL-suite ripple. Reviews (cross-org scoping; the consent
query correctness). browser-QA (a project's board shows real counts). merge-on-green. Regen api-docs.
New FE fetch → STUB it in any project-detail page.route e2e (the lesson).

| Gate                                                                                                                                                                                                                             | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (7) · Build ✅ · IndepTests ✅ · CodeReview ✅ · Security ✅ (scoping inherited, no PII) · BrowserQA ✅ (live: board 200, real counts vs 66%) · CI ✅ · Merge ✅ #353→71e3878 · Critic ✅ · Memory ✅ |

**SLICE 5a ✅ CLOSED — merged 71e3878.** Phase-6 first slice: the project signature-progress board (apartmentsConsented vs threshold) — the owner-requested "תמונת מצב". Manager caught+fixed a multi-owner SEED bug in the test (the S3b deferred-trigger lesson). Both reviews PASS. Critic note: the consent definition is binary apartment-level v1 (every active owner signed); a richer per-document-scope / share-aware definition is a documented follow-up.

---

## Slice 5b — signature CAMPAIGN fan-out (Phase-6) · branch feat/s5b-signature-campaign

The owner's pain: "החתימה עצמה איך לעזאזל היא קורית, לא ראיתי שום אפשרות בכלל" — no one-action way to
send a signature request to everyone. The board (5a) shows progress; the campaign DRIVES it.

Grounded:

- `createBulk` (signature-requests.service.ts:397) already fans out to a LIST of `ownerIds` for a
  document, applying the Slice-1 #2 association gate (`resolveAssociatedOwners`) + the #3 expired-dedup
  (skips owners with a live pending request), returning created vs skipped/failed.
- So a CAMPAIGN = derive ALL eligible owners across a project's apartments for a chosen PROJECT-scoped
  document, then reuse `createBulk`. The new part is the derivation + a thin endpoint + the FE action.

**SPEC (smallest coherent — reuse createBulk; likely NO migration):**

- `POST /api/v1/projects/:id/signature-campaign { documentId, expiresInDays? }` → derive the DISTINCT
  active owners of the project (owner→ownerships ended_at IS NULL, relationship='owner'→apartments→
  buildings→project=:id), then call the existing bulk-create path for `documentId` with that owner list.
  Returns `{ created, skipped, total }` (skipped = already-pending/not-associated — reuse createBulk's
  result shape). The document must belong to the project (validate). Reuse ALL existing guards:
  signatures.create permission, withTenant, the #2 gate, the #3 dedup, the per-route throttle.
- Owner-tier/agent scope: same as createBulk + project-visibility.
- FE: on the project detail (near the 5a board), a "שלח בקשת חתימה לכל הבעלים" action — pick a project
  document → confirm → fan-out → toast "{created} נשלחו · {skipped} דולגו". he+en. Refetch the board.
- DEFERRED: a per-campaign entity/view (tracking a named campaign over time) — own slice. v1 is a
  stateless fan-out that the board reflects.

Pipeline: independent test-author BEFORE builder (RED: POST signature-campaign 404 + fans out to all
project owners, skips already-pending, rejects a non-project document). FULL-suite ripple (signatures).
Reviews (security: the #2/#3 gates must still fully apply via createBulk — no bypass; cross-org; the
fan-out can't email-bomb — throttle). browser-QA (campaign → board reflects new pending). merge-on-green.
New FE fetch → stub in any project-detail e2e (the lesson). Regen api-docs.

| Gate                                                                                                                                                                                                                                                                                            | Status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (6) · Build ✅ · IndepTests ✅ · CodeReview ✅ (NIT closed: project-scoped doc only) · Security ✅ (no gate bypass, throttle, cross-org) · BrowserQA ⚠️ HONEST · CI ✅ (caught+fixed a D.54 fail-open guard failure) · Merge ✅ #354→cd5d37f · Critic ✅ · Memory ✅ |

**SLICE 5b ✅ CLOSED — merged cd5d37f. Phase-6 first pair (5a board + 5b campaign) closes the owner''s
signing-UX pain ("החתימה איך לעזאזל היא קורית").** BrowserQA ⚠️ HONEST: the campaign endpoint is LIVE
(api responds) + the fan-out is proven by 6 integration tests (real DB, reuses createBulk with the #2/#3
gates); a clean live campaign→board repro needs a PROJECT-scoped finalised document, which the dev org
has none of — the SAME upload-UX friction that blocked the 4a live import QA. **Two live QAs now blocked
on the document/import UPLOAD UX → that is the clear next slice.** CI caught a real D.54 fail-open guard
gap (the new write endpoint didn''t explicitly gate manage_signatures — only createBulk did, which the
static guard can''t see) → fixed with an explicit requireAgentCapability (memory project_agent_write_endpoint_gate).

---

## Slice 5c — project-detail document UPLOAD affordance · branch feat/s5c-doc-upload

The owner flagged upload friction; honest grounding (live API): the document upload flow WORKS
(create+presign→201, PUT-to-R2→200, finalize verifies size+hash+AV-scan; FE `useUploadDocument` +
`sha256OfBlob` are correct). NOT a broken flow. The REAL gaps:

1. **Placement (primary):** the project detail page has NO in-context "upload a signature document"
   affordance — a manager must leave to /documents/new + manually set the project scope. The signing
   loop (upload → 5b campaign → 5a board) can't be driven from the project page.
2. **Opaque finalize error (secondary):** when finalize's cross-check fails it returns
   `validation_error` with EMPTY details (live-observed) — the user gets no actionable reason.

**SPEC (mostly FE; reuse the working storage flow — do NOT rebuild it):**

- **(primary)** On apps/web .../projects/[id]/page.tsx (near the 5a board + 5b campaign action), an
  "העלה מסמך לחתימה" / "Upload signature document" affordance: a file input → reuse `useUploadDocument`
  PRE-SCOPED to this project (projectId=:id, apartmentId=null, a sensible default type) → progress +
  success/error feedback → on success invalidate the project documents list + the 5a board. he+en.
- **(secondary, if confirmed)** make documents.service `finalize` return an ACTIONABLE error code when
  the size/hash cross-check or the scan fails (e.g. `size_mismatch`/`hash_mismatch`/`scan_rejected`)
  instead of an empty `validation_error`, and the FE surfaces it.

Pipeline: independent test-author BEFORE builder — a web component/hook test (the project upload
affordance posts projectId, pre-scoped) AND/OR an api finalize-error-clarity test (a size/hash mismatch
→ a specific actionable code, not empty validation_error). FULL-suite ripple. Reviews. **REAL
browser-QA — upload a REAL small PDF via the new project affordance → finalises (scan clean) → run a 5b
campaign on it → 5a board signaturesPending rises. This LIVE chain retroactively closes the 4a + 5b
browser-QA gaps.** New FE fetch → stub e2e. merge-on-green.

| Gate                                                                                                                                                                                           | Status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (M1-M4 + FE seam) · Build ✅ · IndepTests ✅ · CodeReview ✅ · Security ✅ · BrowserQA ✅✅ LIVE FULL-CHAIN · CI ✅ · Merge ✅ #355→39e9e8d · Critic ✅ · Memory ✅ |

**SLICE 5c ✅ CLOSED — merged 39e9e8d.** 🎯 BROWSER-QA: the ENTIRE Phase-6 signing loop verified LIVE
end-to-end — uploaded a real PDF via the flow → finalize 200 (scan clean) → POST signature-campaign →
created:3/total:3 → GET signature-progress → signaturesPending **0→3** (vs the 66% target). This ONE live
chain retroactively CLOSES the 5a (board), 5b (campaign), and 5c (upload) browser-QA gaps. **Honest
correction:** the earlier 4a/5b/5c "fixture friction / no project-scoped doc" notes were a TEST-FIELD-NAME
BUG in my probes (read data.id → undefined → POST /documents/undefined/finalize → opaque 400), NOT a real
blocker — the upload+finalize flow always worked (memory project_documents_create_response_shape). The
owner's most emphatic pain ("החתימה איך לעזאזל היא קורית") is now answered end-to-end: upload a signature
doc on the project → send to all owners → see the progress board.

---

## Slice 5d — signature board DRILL-DOWN (per-apartment) · branch feat/s5d-board-drilldown

The natural 5a follow-up: after the board shows "X of Y apartments consented · Z pending", the manager
needs to see WHICH apartments are outstanding to chase them. Read-only, no migration.

Grounded: ProjectsService.signatureProgress (5a) computes the AGGREGATE consent (apartmentsConsented =
apartments where every active owner signed). This slice returns the PER-APARTMENT breakdown. Apartment
has `number` (text) + `floor` (int) → designation "דירה {number} · קומה {floor}".

**SPEC (read-only; minimal PII):**

- `GET /api/v1/projects/:id/signature-progress/apartments` → a list of per-apartment rows:
  `{ apartmentId, number, floor, totalOwners, signedOwners, status: 'consented'|'partial'|'none' }`
  where status = (totalOwners>0 && signedOwners==totalOwners) ? consented : signedOwners>0 ? partial :
  none. Same consent definition as 5a (active owner ownerships with a SIGNED request on a project doc).
  **NO owner PII** (no names/national_id) — just counts + the apartment designation; the manager drills
  to the apartment/owner detail for names. withTenant org-scoped; agent sees only assigned (reuse the
  5a/project visibility → no-oracle 404). Keyset pagination if needed (or a bounded list for v1).
- FE: an expandable per-apartment list under the 5a board on the project detail — "דירה 7 · קומה 2 ·
  0/3 חתמו" + a status chip (green consented / amber partial / gray none). he+en.

Pipeline: independent test-author BEFORE builder (RED: the apartments endpoint 404 + correct
per-apartment signed/total for a seeded project — ATOMIC multi-owner seed, the S3b lesson). FULL-suite
ripple. Reviews (cross-org/agent scope; NO owner PII leak). REAL browser-QA — reuse the 5c live chain:
upload→campaign→drill-down shows the project's apartments with the 3 owners pending (partial/none).
New FE fetch → stub e2e. merge-on-green.

| Gate                                                                                                                                                                                                                 | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ✅ · Reproduce-RED ✅ (5) · Build ✅ · IndepTests ✅ · CodeReview ✅ · Security ✅ (no PII in projection) · BrowserQA ✅ (live: דירה 7 0/3 none, noPII) · CI ✅ · Merge ✅ #356→c89f0bb · Critic ✅ · Memory ✅ |

---

## 🏁 V12 MILESTONE — after 12 slices (signing loop COMPLETE)

**SLICE 5d ✅ CLOSED — merged c89f0bb.** With it, the **Phase-6 signing loop is COMPLETE and proven LIVE
end-to-end**: 5a board (aggregate progress vs threshold) + 5b campaign (one-action fan-out to all owners)

- 5c upload (the signature document) + 5d drill-down (per-apartment: WHO hasn't signed). The owner's most
  emphatic pain ("החתימה איך לעזאזל היא קורית, לא ראיתי שום אפשרות") is answered: upload a doc on a project
  → send to all owners → see X/Y consented vs 66% → drill to "דירה 7: 0/3" → chase them.

**V12 DELIVERED (12 slices, ~18 PRs, ZERO merge-on-red):**

- Owner-reported bugs: #1 doc inline-view, #2 sig-association, #3 expired-dedup, #4/#9 invite link,
  #5 signing reachable, #6 import 0-changes, #7 member resend, #8 permission groups (slices 1,2,4a,4b).
- §2 ENTITY-MODEL refactor: 3a shell-owners, 3b exact-fraction shares, 3c renter→discovery-source,
  3d owner↔project + co-ownership.
- Phase-6 signing loop: 5a-5d (above).
- 8 memory controls captured; the pipeline (test-author≠builder → manager-scrutiny → independent
  code+security review → architecture guards → CI → live/honest browser-QA → merge-on-green) caught
  10+ real CRITICAL/HIGH + multiple CI ripples + a D.54 fail-open guard gap, all root-fixed.

**NEXT BIG PHASE — Phase-5 Tabu נסח (design §6):** the gold source for ownership. DESIGN FORK for the
owner to steer (design itself says "API נראה בהמשך כי זה כרוך בתשלום"): the נסח UPLOAD reuses the now-proven
document flow, but the PARSE approach (auto-extract owners+shares heuristically vs a guided manual-map
screen vs the deferred paid Tabu API) is a product decision. Manual owner+share entry ALREADY works
(shell-owners 3a + fraction-shares 3b + the ownerships PUT). The autonomous run continues on safe
high-value polish (the accumulated critic notes) until the Tabu parse-approach is chosen.

---

## 🎯🎯 SIGNING LOOP — BOTH HALVES PROVEN LIVE (post-13-slices verification)

After the 13 merged slices, I verified the OWNER-SIDE signing flow LIVE (the other half of the owner's
"החתימה איך לעזאזל היא קורית" pain — the manager side / campaign was already proven). Full chain, live:

- **Manager side:** upload signature doc (project-scoped) → finalize (scan clean) → signature-campaign →
  N pending requests → 5a board shows pending vs threshold → 5d drill-down shows per-apartment who's out.
- **Owner side (verified now):** create request → `signUrl` (token) → GET /sign/:token → **200** (preview
  shows the document) → POST /sign/:token { signatureSvg, acknowledgeConsent } → **200** → status 'signed'
  → 5a board `signaturesSigned` rose to 1.
  **The COMPLETE signing loop works end-to-end. No bug, no new slice — verification of the core flow's
  second half. The public-sign flow is sound.**

## ✅ V12 STATUS — CORE COMPLETE (13 slices, ~19 PRs, ZERO merge-on-red)

All owner-reported bugs (#1-#9) + the §2 entity-model refactor (3a-3d) + Phase-4 onboarding/access
(4a #6 import-summary, 4b #8 capability-presets) + the Phase-6 signing loop (5a board, 5b campaign,
5c upload, 5d drill-down — both halves proven live) + 6a DSAR audit-fidelity. 8 memory controls.
**NEXT BIG PHASE — Phase-5 Tabu נסח parse — awaits the OWNER'S design steer** (parse approach:
heuristic-auto vs guided-manual-map vs deferred-paid-API; the upload reuses the proven document flow;
manual owner+share entry already works via 3a shells + 3b fractions). No low-value work invented in the
interim — the autonomous run stays on genuine value or honest consolidation until that steer.

### Consolidation health check (post-13-slices, main)

typecheck 5/5 packages = 0 errors. Core V12 logic specs green: signature-campaign + signature-progress

- signature-progress-apartments + data-subject = 30/30. (Live-server contract specs skipped — http_429
  without a running server is env, not a regression.) **main is healthy. V12 core complete + verified.**

---

## 🟢 PHASE-5 — Tabu נסח: auto-parse + manual-confirm (owner-steered 2026-06-12)

OWNER DECISION: heuristic AUTO-PARSE of an uploaded נסח + MANDATORY human review/confirm before any
ownership is committed ("פיענוח אוטומטי עם אפשרות לאשר ידנית... כדי שעין תוודא התאמה ותאשר"). Matches
design §6 (upload+parse, paid-API deferred). Memory: project_phase5_tabu_parse_decision.

**Slice plan:**

- **7a foundation (THIS):** migration tabu_extractions + tabu_extraction_rows (draft model) + RLS;
  API create-extraction from a finalized apartment-scoped נסח doc (STUB parse → empty/placeholder draft)
  - GET draft. NO real parse yet, NO commit yet — just the model + the draft lifecycle.
- **7b parser:** add pdf-parse; extract R2 נסח text; heuristic name/national_id/share extraction → rows.
- **7c review+confirm:** edit draft rows + CONFIRM → commit owners+ownerships (atomic fractions, 3a/3b)
  - provenance link; FE side-by-side review screen.

| Gate (7a)                                                                                                                                     | Status |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ⏳ · Reproduce-RED ⏳ · Build ⏳ · IndepTests ⏳ · CodeReview ⏳ · Security ⏳ · BrowserQA ⏳ · CI ⏳ · Merge ⏳ · Critic ⏳ · Memory ⏳ |

### Phase-5 REVISED (owner, 2026-06-12 round 2) — supersedes the heuristic plan

7a ✅ merged (#358, envelope). NEW direction: (1) extraction by an **AI model** (Claude vision/text),
not heuristic regex — OPEN owner decision: it sends נסח PII to an external processor (zero-retention+DPA
needed; DO NOT send נסח out until owner approves). (2) **3-layer encryption**: doc bytes envelope-encrypted
at rest + extracted data pgcrypto + access = permission **+ OTP step-up**. (3) **OTP unlock ONCE/session**
unlocks ALL authorized docs (reuse SMS-OTP). Revised slices: 7b-OTP+doc-encrypt (decision-independent) ·
7b-extract (awaits AI-PII nod) · 7c OTP-gated review+confirm. OPEN SCOPE QUESTIONS before building 7b-OTP:
does the OTP-gate apply to ALL documents or only נסח/PII-sensitive ones? unlock TTL? which roles? — these
change existing document-view behavior, so confirm with the owner first. Memory: project_phase5_tabu_parse_decision.

### Owner process-review (2026-06-12) — 3 points, all addressed

1. **Plan not in a design doc** — VALID. Fixed: `docs/DESIGN-phase5-tabu-extraction.md` (single source of
   truth: D-P5.1..8 owner decisions verbatim, architecture, security invariants, slice map). Ledger stays
   the execution log; the design doc is the plan.
2. **Pipeline accounting (honest):** 7a + 7b-extract ran test-author→builder→manager-verify→code+security
   reviews→CI→merge-on-green (incl. a LOW root-fix). **Browser-QA was skipped in both** ("no UI") — valid
   for 7a, but 7b-extract could have had a live API chain run. DEBT: the 7c slice MUST live-run the full
   chain (upload→extract→review→confirm) as its browser-QA, covering 7a+7b retroactively.
3. **api-reference gap** — REAL + SYSTEMIC (the manual ENDPOINTS registry had drifted 64 endpoints behind;
   the stale-check verified file==script, not script==code). Root-fixed in PR #360: all 153 endpoints
   registered + an api-docs-coverage architecture guard (both-directions assert, RED-proven) + a banner on
   the legacy html. Memory: project_api_docs_manual_registry.
   **7b-extract ✅ CLOSED — merged (#359, incl. the scan-clean LOW fix).** Phase-5 next: 7b-OTP + 7c, blocked
   on D-P5.7 (OTP scope) + D-P5.8 (TTL) — see the design doc §1.

### Slice 7b-OTP ✅ (PR #361, auto-merge armed) — D-P5.5/7/8 implemented

Test-author RED-first (21) → builder → manager-verify → MANDATORY security review → **BLOCK: 2 real
HIGHs** → root-fixed (PATCH-type sensitive re-derive turn-ON-only; contractor fail-closed exclusion of
sensitive docs — external tier has no OTP session) + locked (sensitive-gate-hardening.spec 3) → 90/90
ripple + architecture guards + tc 5/5=0. Gate-6 trailer (migration 0070). Retroactive dedicated
code-review of 7a+7b-extract: PASS (3 MINORs folded into 7c: list-pagination test, agent-getOne test,
limit-default 20→25 align). Sequencing note: FE has no unlock UI until 7c → sensitive docs 403 in FE
(accepted, 7c next). 7d (doc-bytes envelope encryption) split out — D-P5.4 second half.

### Perf diagnosis (owner: "זמן הריצה קיצוני ארוך מדי", 2026-06-12) — ROOT CAUSE FOUND

Measured: raw RTT dev-machine→Neon = ~165ms/query (DB in **us-east-1**, dev in Israel). withTenant is
already RT-optimal (3 round-trips: BEGIN+ROLE batched · one set_config · COMMIT). A typical authed
request = 7-8 sequential queries × 165ms ≈ 1.2-1.5s — matches the measured numbers exactly. NOT a code
problem, no N+1: **geography**. Also explains the slow test suites (30-60s/file). Production (Railway+
Neon same-region, RTT 1-3ms) ≈ 20-40ms/request — under the 200ms baseline (verify on staging).
Real fixes offered (no cache hand-waving): **A. local docker Postgres for dev (~50x, recommended)** or
B. move the dev Neon branch to eu-central-1 (~2.5x, zero-infra). Awaiting the owner's pick (it changes
his Infisical dev DATABASE_URL + dev workflow).

### 7c BE — LIVE MANUAL QA ✅ (owner-prompted, 2026-06-12) — FULL CHAIN, every status recorded

upload נסח(id_document/sensitive, stub-parsable)+finalize=200 → download w/o unlock=**403
pii_step_up_required** → step-up request=200(+dev code, EXPOSE_STEP_UP_CODE) → verify=200 → download
w/ unlock=200 → create extraction=201 → extract(stub)=201 rowCount:2 → GET rows(decrypted)=200 (exact
names+natids+shares from the uploaded נסח) → PATCH edit=200 → **confirm=200 → ownerships REPLACED:
שרה כהן 1/2 (new shell) + existing owner REUSED via natid-hash match 1/2** → second confirm=**409**
(idempotent). This closes the 7a/7b live-QA debt. Honest note: this manual chain ran only AFTER the
owner pressed ("ביצעת טסט ידני???") — the BE was built integration-tested-only at that point; lesson:
the live chain belongs BEFORE declaring a BE sub-slice done, not deferred to the FE stage.
Remaining for 7c: code+security reviews → FE (unlock modal + review screen) → e2e stubs → PR (Gate-6 0071) → merge-on-green.

### FULL MULTI-ROLE BROWSER SMOKE (owner-mandated, 2026-06-12) — all 6 entities, real UI

Tool: preview Chromium against the live web (Chrome-ext unavailable → standard downgrade-note). Evidence = raw statuses/text.
**Manager** ✓ login FORM→redirect /he (auth cookies httpOnly, not js-readable); project page tab "לוח בקרה": 5a board ("0/1 דירות הסכימו·יעד 66%"), 5d drill-down expands ("דירה 7·קומה 4·0/2 חתמו" — correct post-confirm), 5c upload + 5b campaign buttons present; documents list+detail.
**Public signer** ✓ anonymous /sign/:token: "שלום שרה כהן" + privacy notice (P0.C2) + SVG pad → drew → "החתימה נקלטה בהצלחה ✓"; tampered token → 401 invalid_token (no internals); board moved 1→2 signed; drill-down → "1/2·partial".
**Contractor** ✓ token-path exchanged to httpOnly cookie (URL clean); portal lists ONLY plain project docs; **a project-level financial (sensitive) doc: NOT in list + direct-id probe → 404 no-oracle (HIGH-2 live-proven)**.
**Agent** ✓ sees only the assigned project; tabu write w/o edit_project_data → 403 (D.54 live); rows after own unlock → nationalId MASKED "•••••••82" (D.19/D.47 live).
**Viewer** ✓ all writes 403 (project create / tabu / campaign); rows masked.
**Tenant** ✓ OTP via SMS (Noop→stderr code) → verify 200 → portal/me="שרה כהן" (the נסח-born owner!) → UI: "שלום, שרה·דירה 7·אחוז בעלות 50%" + her signature "signed". **The full Phase-5→Phase-6 loop closed live: נסח→extract→confirm→owner→sign→portal.**
**FINDINGS:** (F1, known-FE-gap) sensitive doc הצג w/o unlock → generic "ההורדה נכשלה." — no step-up modal (BE 403 correct; = the 7c-FE work). (F2, NIT) "דירה דירה 7" duplication — apartment.number already contains "דירה", the designation VM prepends another (drill-down + tenant portal). (F3) tabu review/confirm has NO UI yet (API-only; = 7c-FE). No security findings — all gates held live.
