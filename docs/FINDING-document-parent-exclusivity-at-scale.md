# At-scale finding — document parent-exclusivity breaks home-KPI ↔ board reconciliation

Date: 2026-06-26 · Found by: at-scale verification of the smart-managing core
(local PG, 2261 orgs / 5404 projects / 5061 owners / 4762 documents).

## The defect (the "0 מתוך X" divergence class)

A document could be created carrying **both** `project_id` **and** `apartment_id`.
The canonical signature-doc resolution
(`packages/db/src/helpers/signature-progress.ts`, reused everywhere) is a UNION of:

- the project-level path: `documents.project_id = P`, and
- the apartment-level path: `apartment → building → project`.

So a both-parent doc is reachable from **two projects at once**. The two surfaces
that must agree then diverge:

| Surface                                                           | Shape                                   | Counts a both-parent doc…               |
| ----------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Home KPI (`computeOrgStats`)                                      | one UNION over the whole org's projects | **once**                                |
| Per-project board (`signatureProgressByProject`, run per project) | the UNION runs per project              | **twice** (once per project it maps to) |

Both render on the same screen, so the home KPI cannot reconcile to the sum of
the per-project boards.

### Measured (Alpha org `f4c183e2-d5ef-4b81-9a47-29162d3f9626`)

```
KPI        : 38 signed / 6 pending
board_sum  : 62 signed / 8 pending   ← 24 phantom signed, 2 phantom pending
```

The entire gap is the **27 cross-project both-parent docs** in Alpha. Excluding
both-parent docs, the two sides reconcile exactly (12 == 12). Fleet-wide: **41
both-parent rows across 13 orgs** (26 cross-project).

### Root cause

1. `CreateDocumentInput` (the FE/BE contract) had **no parent-exclusivity
   refine** — a client could POST both ids; the service inserted both.
2. The dev/demo seeders (`seed-dev.ts`, `seed-demo.ts`) **always set
   `project_id`** even for apartment-scoped docs — the source of the existing
   both-parent rows.

The model already intends single parentage ("a document may hang off a project,
an apartment, or be org-level"); production's normal path sets one or the other.

## The fix (shipped in this PR — application layer, NOT owner-gated)

- `CreateDocumentInput` gains a `.refine` rejecting both-parent
  (`packages/shared-types/src/document.ts`) — the single FE/BE source of truth.
- `DocumentsService.create` adds a defense-in-depth guard
  (`document_parent_exclusive` 400) for any internal caller bypassing the DTO.
- Both seeders set `project_id = NULL` for apartment-scoped docs (apartment
  wins — it already resolves to the project via its building).
- Contract spec covers accept-project-only / accept-apartment-only /
  accept-org-level / reject-both.

Proof the fix reconciles: replaying the Alpha data with the fixed linkage
(apartment-scoped → `project_id` NULL) yields **KPI 38/6 == board_sum 38/6**.

## OWNER-GATED follow-up — migration `0083_document_parent_exclusivity.sql`

The application fix prevents NEW both-parent rows. Existing rows (41 across 13
orgs in the dev DB; unknown in prod) need a one-time backfill, and a CHECK
constraint makes the invariant structural. This is a **data backfill on live
data → owner-gated**. The migration is authored + journaled (idx 83) and is
one-click:

```
# dev (local sandbox):
DB_TARGET=local LOCAL_DATABASE_URL=… pnpm --filter @emapp/db db:migrate
# prod: apply 0083 in the normal migration window.
```

What it does:

1. `UPDATE documents SET project_id = NULL WHERE project_id IS NOT NULL AND apartment_id IS NOT NULL`
   — apartment wins. **Verified safe**: every both-parent doc has a valid
   apartment→building→project chain (0 dangling), so no doc is orphaned and no
   signature is lost — each is simply counted under one project instead of two.
2. `ALTER TABLE documents ADD CONSTRAINT documents_parent_exclusive CHECK (NOT (project_id IS NOT NULL AND apartment_id IS NOT NULL))`.

## Other at-scale axes — clean bill (verified, no fix needed)

- **Autonomy producer**: all 4 recommenders (signature-reissue, reminder-cadence,
  task-watcher, document-chase) emit correct conditions, idempotent (0 duplicate
  pending (org,dedup_key) pairs), PII-free evidence, all detect queries <26 ms at
  5404-project scale. The perception assembler does not reproduce its historical
  statement_timeout (15–26 ms).
- **Latency**: org-stats (~12 ms), board-completeness (~13 ms), inbox
  pending-count (~2 ms, index-only scan on the partial index) are all index-backed
  and flat with project count. The one structural scaling note: `signaturePulse`
  resolves consent **per visible project** (bounded concurrency 8, read-through
  cached). Steady-state warm hits cache (0 queries); the cold path after a
  consent-write invalidation is linear in project count (~4.4 ms/project,
  planning-cost-dominated). At many hundreds of projects in one org the cold path
  could approach the 200 ms budget. Fix if it ever bites = a **query-shape**
  refactor (one set-based grouped consent aggregate over all visible projects),
  **not a new index** (exec is already 0.24 ms, 0 seq-scans). Documented, not a
  current blocker.
- **Cross-org isolation**: RLS holds at 2261-org scale across tenant, agent-scope
  (project_assignments inner-join), contractor/external-party, tenant own-record,
  and audited provider paths. Every attempted cross-org read returned zero rows.
