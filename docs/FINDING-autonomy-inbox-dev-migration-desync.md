# FINDING — Approval Inbox 500 in dev: unapplied + renumber-desynced migrations

**Found:** 2026-06-23 via real-Chrome QA (owner's browser) of the deferred #505 walk.
**Severity:** HIGH for dev QA (feature non-functional in dev). LOW for prod (see §Prod).
**Status:** Owner-gated — apply blocked by the standing migration boundary. One-click prepared below.

## Symptom (what the owner's Chrome saw)

As manager → `/he/inbox` (Approval Inbox):

- Header copy renders correctly (voice-law PASS): _"החלטות ממתינות — לפי הכללים שלך, מוכן לאישורך. כל החלטה היא שלך, בלחיצה אחת."_ No first-person system-hero voice.
- The proposals fetch fails: `GET /api/v1/proposals?limit=25` → **500**, inbox shows the error
  state _"לא הצלחנו לטעון את הנתונים — אירעה תקלה זמנית."_

## Root cause

API log: `pgcode=42P01 relation "proposals" does not exist`.

The autonomy + external-share tables are **absent from the dev DB**:
`external_share`, `proposals`, `outbound_ledger` all `to_regclass = NULL`.

The code (#506 proposals controller/service, #507 external-share resolver) is merged on
`main` and the routes are registered (`Mapped {/api/v1/proposals, GET}`). Only the DB
migrations were never materialized in dev.

### Why a naive `pnpm db:migrate` is UNSAFE here (the real trap)

The dev `__drizzle_migrations` journal is **desynced from the renumbered files** — the
classic _renumber-after-apply_ corruption:

- Migration files now: `0078_search_indexes` (when `1783400000000`), `0079_external_share`
  (`1783500000000`), `0080_proposals` (`1783600000000`), `0081_outbound_ledger`
  (`1783700000000`).
- Dev DB applied-watermark = **`1783586400000`** — a value matching **no current journal
  tag** (it's the leftover `when` from the _pre-renumber_ version of these migrations,
  applied to dev before the 0077→0079/0080/0081 renumber on merge).
- The DB even records `when` `1783400000000` + `1783500000000` as "applied" (so it _thinks_
  0078 + 0079 are done) — yet their DDL is absent (search-index count 0, `external_share`
  missing). The journal lies.

Consequence: drizzle's migrator takes a single watermark and **silently skips** any journal
entry whose `when` ≤ watermark (the documented M-1 finding). With watermark `1783586400000`:

- `0079_external_share` (when `1783500000000` < watermark) → **SILENTLY SKIPPED** → table
  stays missing, no error.
- `0080_proposals` / `0081_outbound_ledger` (when > watermark) → applied.

So `pnpm db:migrate` would "succeed", create proposals+outbound_ledger, and leave
`external_share` broken with a green log. Do **not** use it as-is.

## Safe one-click apply (dev) — owner runs this

All three files are idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`, policy creation in
existence-guarded `DO` blocks), additive (no DROP), and "Reversibility: HIGH". Apply the
raw SQL directly (bypasses the watermark logic), in FK order:

```bash
cd C:/emapp/packages/db
infisical run --silent -- node -e "
const fs=require('fs');const{Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
for(const f of ['0079_external_share','0080_proposals','0081_outbound_ledger']){
  await c.query(fs.readFileSync('migrations/'+f+'.sql','utf8')); console.log('APPLIED',f);}
const t=await c.query(\"select to_regclass('public.external_share') es,to_regclass('public.proposals') p,to_regclass('public.outbound_ledger') o\");
console.log(JSON.stringify(t.rows[0])); await c.end();})().catch(e=>{console.error(e.message);process.exit(1)});"
```

After it prints all three non-null, restart the API (already running on :3000) is NOT needed
— the tables appear live; just reload `/he/inbox`. The remaining #505 walk (seed a pending
proposal → approve/reject happy-path) can then complete.

## Prod impact — LOW

A prod DB never saw the pre-renumber `when` values, so its watermark sits at 0078's `when`
and 0079/0080/0081 apply in order with no skip. The desync is a **dev-only artifact** of
applying-then-renumbering. Prod deploy of these migrations is unaffected — but the
migrator-guard spec should grow a check for _DB-watermark vs journal-tag_ divergence (today
the M-1 guard only checks journal-internal monotonicity, which passes here while the DB is
still inconsistent).

## What this QA tick confirmed regardless

- **#504** (per-party document completeness) — PASS. `/he/documents` board shows real
  per-party counts + recency (בעלים 1 · אדריכל 5 · קבלן 16 · עו״ד 3) and "טרם התקבלו
  מסמכים" for the 5 empty parties; `GET /documents/board-completeness` → 200; summary math
  ("שמאי ועוד 4" = 5 empty) consistent. Not a project-count denominator.
- **#502** (doc grouping by party) — PASS. Documents group under the party derived from
  doc_type; correct distribution + empty-party messaging.
- **#505** (approve happy-path) — BLOCKED on the owner-gated migration above. Inbox shell +
  voice-law verified; the click-walk needs the table.
- Console: only turbopack HMR chunk-reload noise (dev-only, excepted).
