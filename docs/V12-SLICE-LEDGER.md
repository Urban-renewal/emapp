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

| Gate                                                                                                                                          | Status |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Spec ⏳ · Reproduce-RED ⏳ · Build ⏳ · IndepTests ⏳ · CodeReview ⏳ · Security ⏳ · BrowserQA ⏳ · CI ⏳ · Merge ⏳ · Critic ⏳ · Memory ⏳ |

Rule: any real-red → slice stays OPEN with the blocker named here; never force-merge.
