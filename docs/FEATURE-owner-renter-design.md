# Feature A — Owner / Renter distinction + inline person entry (design, implementation-ready)

Owner-authorized (this session): add `relationship: owner | renter`; a **renter does
NOT sign and is NOT counted toward the 100% ownership**; plus inline person creation
when attaching to an apartment (removes the two-step). This doc is the build plan so
it's implemented cleanly in fresh context — NOT rushed at the tail of a long session,
because step 2 alters a high-blast-radius LOCKED invariant (D.25).

## Why this is its own focused task

The D.25 trigger `trg_ownerships_sum_check` enforces `SUM(ownership_pct) per apartment
∈ {0, 100}` for EVERY apartment. Changing it to "sum OWNERS only" is correct per the
owner's decision, but a subtle trigger error corrupts the ownership invariant org-wide.
It needs: a hand-authored migration, a real-DB test proving the new invariant, AND a
security review — done with a clear head, with the owner able to review the trigger SQL.

## Step 1 — schema + shared-types (additive)

- `packages/db/src/schema/projects.ts` `ownerships`: add
  `relationship: text('relationship').notNull().default('owner')` (or a pgEnum
  `ownership_relationship` = `['owner','renter']`). Default 'owner' so every existing
  row becomes an owner (safe backfill).
- Make `ownership_pct` semantics: owners must sum to 100; **renters carry NULL (or 0)
  pct** and are excluded from the sum. Keep the column NOT NULL? → change to allow the
  renter case: either (a) renters store `0` and are excluded by `relationship`, or
  (b) make pct nullable for renters. RECOMMEND (a) `0` + exclude-by-relationship — keeps
  the column NOT NULL, the trigger filters on relationship.
- `packages/shared-types/src/ownership.ts`: add `relationship: z.enum(['owner','renter'])`
  to the row schema + the set-input schema. (additive — but it's a REQUIRED field, so the
  same fixture-cascade lesson applies: update every ownership fixture/mock/spec — the
  suspended-badge PR is the template for finding them all.)

## Step 2 — the migration (the careful part)

Hand-author `packages/db/migrations/00NN_ownership_relationship.sql` + a `_journal.json`
entry (`when` = prev max + 86400000). Contents:

1. `ALTER TABLE ownerships ADD COLUMN relationship text NOT NULL DEFAULT 'owner';`
   (+ a CHECK or enum constraint to `('owner','renter')`).
2. Replace the sum-check trigger function so it sums ONLY owners:
   ```sql
   -- was: SUM(ownership_pct) WHERE apartment_id = NEW.apartment_id
   -- now: SUM(ownership_pct) WHERE apartment_id = NEW.apartment_id AND relationship = 'owner'
   ```
   Keep the {0,100} rule on the OWNER sum. Renters never affect it.
3. Idempotency-guard the trigger replace (CREATE OR REPLACE FUNCTION) and re-bind the
   trigger if needed.

- **Verify on a LOCAL DB first** (the migrator defaults to DATABASE_MIGRATE_URL = Neon —
  override to local). Prove: existing apartments still validate (owners sum 100); adding
  a renter (relationship='renter', pct 0) does NOT break a 100% apartment; owners summing
  to 90 still REJECT.

## Step 3 — ownerships service

- `apps/api/src/modules/ownerships/ownerships.service.ts` (the atomic full-set REPLACE
  PUT): accept `relationship` per row. Validate: owners' pct sums to 100 (renters
  excluded); renters have pct 0/null. The atomic REPLACE invariant (D.25) is PRESERVED —
  the set still writes atomically; only the sum predicate changes.
- The owner-visibility / PII handling is identical (a renter is still a person in the
  `owners` table — name/national_id/phone encrypted the same).

## Step 4 — signature flow targets OWNERS only

- Anywhere signature requests are created for "an apartment's people" (bulk send by
  building/apartment), filter to `relationship = 'owner'`. A renter never receives a
  signing link (they don't consent). Audit the resident-portal + bulk-send owner
  resolution paths. The consent-threshold (Feature B) counts owners only — already true
  (signatures are per owner), so no double-fix needed, but verify renters can't be added
  to a signature request.

## Step 5 — FE: owner/renter toggle + inline create (closes the two-step, D-O / concern 2B)

- `apps/web/.../apartments/[id]/ownerships/page.tsx`: each row gets a relationship select
  (בעלים / שוכר). Renter rows hide/disable the % field (or force 0). The owners-sum
  validation in the UI counts owners only.
- INLINE create: add a "+ אדם חדש" affordance that opens a mini owner-create form (reuse
  the `/owners` POST + the create-owner hook), then the new person appears selectable in
  the same flow — no separate page trip. This does NOT break D.25 (you create the person,
  then the existing atomic PUT links the full set).
- i18n (he + en) for the relationship labels + inline-create.

## Tests + review (mandatory, builder ≠ test-author ≠ reviewer)

- Real-DB: the new trigger invariant (owners-100 enforced, renter-excluded), the service
  REPLACE with mixed owner/renter sets, signature-send excludes renters.
- Security review: the migration/trigger (high-blast-radius), the PII parity for renters,
  no RLS regression.
- The fixture-cascade sweep (every ownership mock/fixture/spec gets `relationship`).

## Open question for the owner (small)

- A renter's `ownership_pct`: store `0` (recommended — keeps column NOT NULL, trigger
  filters by relationship) vs make it nullable. Confirm `0` is acceptable.
- Should a renter appear in the contractor/portal AGGREGATE counts as a "resident"? (The
  agent-KPI residents count = distinct owners; decide if renters count as residents for
  display. RECOMMEND: residents = owners + renters for "who lives here" counts, but
  consent math = owners only.)
