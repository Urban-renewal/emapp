# P2 DECISION RECORD — Feature A: owner/renter distinction (D.25 sum-trigger change) (risk: HIGH)

Status: APPROVED-TO-BUILD (analysis done, code-grounded). The D.25 trigger SQL is reviewed
again by the security-reviewer before the migration merges. Owner granted full autonomy with
high-risk documented; owner's confirmed direction: `relationship ∈ {owner,renter}`, renter
`ownership_pct=0`, excluded from consent/sum math, counts as a "resident" in display only.

## PROBLEM — blast radius

The D.25 invariant (`SUM(ownership_pct) per apartment ∈ {0,100}`) is a `CONSTRAINT TRIGGER
DEFERRABLE INITIALLY DEFERRED`. The **live** function body is `trigger_check_ownership_sum()`
in `migrations/0030_ownerships_sum_trigger_per_statement.sql:36-82` (it superseded the 0002
definition via `CREATE OR REPLACE`, reusing the same binding). It fires on every ownership
write (every `replaceSet` PUT ends+re-inserts the full set). Feature A changes the SUM
predicate to `... AND relationship='owner'`.

- **Too-permissive error** (filter dropped/mistyped) → owners not totalling 100 silently
  accepted → broken consent denominator. The dangerous, silent mode.
- **Too-strict error** (renter pct=0 counted) → legitimate 100%-owner writes start 400ing → a
  write outage. Loud, caught fast.
- **Memo layer** (`_ownership_sum_checked`, keyed by apartment_id) must stay untouched; only the
  inner SUM's WHERE changes.
- **Existing-data risk LOW but must be proven:** every existing row backfills to
  `relationship='owner'`, so the new predicate over existing data is identical to today's → no
  currently-valid apartment can newly violate. Theoretical only; verify on a data copy.
- **Naming:** `ownerships` already has a `role text` column (`projects.ts:210`, values like
  'primary'). The new field is `relationship` — DISTINCT, must not overload `role`.

## OPTIONS + RECOMMENDATION

1. **pct storage → (a) renter pct=0, column stays NOT NULL, trigger excludes by relationship.**
   (vs nullable pct — rejected: drops a NOT NULL guardrail, no functional gain since the trigger
   excludes by `relationship` anyway.) Relax the `shareEntry` Zod refine: `renter ⇒ pct===0`,
   `owner ⇒ pct>0`; keep the set-level refine that OWNERS sum to 100 (renters excluded) so the
   in-app 400 and the DB backstop agree.
2. **Trigger change → modify in place via `CREATE OR REPLACE FUNCTION`** (the 0030 pattern):
   add `AND relationship='owner'` to the SUM WHERE, keep `{0,100}` on the owner sum, keep memo
   logic, and **add `SET search_path = pg_temp, public`** — closing the known §v8-M5 gap in the
   same migration (that item explicitly says "next ownership-trigger migration adds it"). New
   hand-authored `00NN_ownership_relationship.sql` + `_journal.json` (`when`=prev max+86400000).
3. **`relationship` type → `text` + `CHECK (relationship IN ('owner','renter'))`, `DEFAULT
'owner' NOT NULL`** (matches the existing `role text` precedent on the same table; trivially
   extensible; safe backfill), with **Zod `z.enum(['owner','renter'])` as the authoritative
   API-edge enforcement.** (pgEnum is an acceptable alternative if the team prefers DB typing.)
4. **Residents-count → leave display queries UNCHANGED.** `projects.service.ts:304,315`
   (`COUNT(DISTINCT owner_id) WHERE ended_at IS NULL`) and the portal progress auto-include
   renters once they're ownership rows — exactly the owner's "residents = owners+renters,
   consent = owners only" split. Consent runs off `signature_requests`, not relationship.

## ⚠️ The load-bearing risk (reviewer's first confirmation)

Renter-can't-sign is **NOT** enforceable in `SignatureRequestsService` — it takes `ownerId`
directly and is relationship-agnostic (`signature-requests.service.ts:151,272-283`). The
guarantee MUST live at the layer that ASSEMBLES the apartment's `ownerIds` for bulk-send /
owner-resolution, with an explicit `relationship='owner'` filter. The build must locate that
layer and gate it there + test it (design doc §step-4).

## VERIFICATION PLAN (all mandatory before merge; builder ≠ test-author ≠ security-reviewer)

- **A. Real-DB trigger invariants** (LOCAL db, override `DATABASE_MIGRATE_URL`): (1) owners=100
  COMMITs; (2) adding renter pct=0 does NOT break a 100% apartment; (3) owners=90 still REJECTs
  (→400 `ownership_sum_invalid`); (4) renter non-zero pct rejected at the edge + trigger ignores
  it; (5) renter-only apartment → owner sum 0 passes the `v_total>0` guard (confirm this
  semantic with the owner); (6) assert the function carries `SET search_path`.
- **B. Service REPLACE** mixed owner+renter set persists renter `relationship='renter'`; in-app
  pre-validation and the trigger AGREE.
- **C. Signature exclusion (negative guarantee):** the owner-resolution layer returns ONLY
  `relationship='owner'`; a renter can never be put on a signature request.
- **D. Fixture-cascade sweep:** `relationship` becomes a REQUIRED Zod field → update every
  ownership mock/fixture/seed/spec (seed-demo/dev/volume/verify, ownerships.contract,
  ownerships-fidelity, portal.s4, orgstats-agent-scope, signature-requests-bulk, contractor/
  export specs) + `toOwnership`/`listApartmentOwners`/`ApartmentOwnerSchema` surface it.
- **E. Migration safety:** run on a data copy; validator query asserts ZERO apartments violate
  `SUM(pct) WHERE ended_at IS NULL AND relationship='owner' ∈ {0,100}`; confirm backfill left no
  NULL relationship before the trigger starts excluding rows.
- **F. Security review:** the trigger/migration SQL (predicate, search_path, idempotency,
  journal entry), PII parity for renters (a renter is a full `owners` person — name/national_id/
  phone encrypted identically; no clear-text divergence), no RLS regression (still via
  `withTenant`, via-parent isolation unchanged).

## Build order

schema+CHECK+shared-types (relationship; relax shareEntry refine) → hand-authored migration
(trigger predicate + search_path + backfill) VERIFIED ON LOCAL DB → ownerships service (accept
relationship; owners-only sum) → owner-resolution signature gate (relationship='owner') → FE
(owner/renter toggle + inline create) → fixture sweep → tests (A–E) → security review (F) →
manager verify → PR.
