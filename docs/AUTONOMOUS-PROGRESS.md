# Autonomous progress + decisions log

Running the roadmap autonomously (owner away). Logging every decision/blocker.
Order = owner's: import-preview+undo → lifecycle/scheduler → notifications+settings,
plus the cross-cutting directives: **SOLID/modular signing** (swappable for a
future external e-sign integration) and the **Hebrew signed-PDF "mess"**.

## Verified gap backlog (from the 4 independent audits)

1. ✅ Signed-doc 500 on non-Hebrew names — FIXED (encodeSafe) + pushed (7f55b3c).
2. ✅ Signed-doc permission split-brain — FIXED + SOLID refactor (b6f1602).
3. 🟡 Ghost documents / NoSuchKey — DOWNLOAD path FIXED + E2E-verified (843aa4e,
   migration 0049 + uploaded_at gate on getDownloadUrl). Slice 2 = the same gate
   on tenant-portal / contractor-portal / signature create+preview surfaces.
4. ⏳ No scheduler at all → R2 PII-byte leak, signature-expiry never finalizes/
   notifies, "overdue" inert. Foundational.
5. ✅ task_assigned not fired on manager-create-with-assignees — FIXED (26963a6).
6. 🟡 Import PREVIEW→confirm — DONE + E2E-verified (c23cb1b/ef7d24a/b57c8a2).
   UNDO — deferred-by-risk (see D-A3). Owner's #1; preview is the main protection.

## NEXT: import preview + undo (design ready, from audit-3)

- **Migration (Gate-6, hand-authored .sql + \_journal.json):**
  - `import_changes` ledger: (id, org_id, import_job_id FK, entity_table, entity_id,
    action ∈ created|attached|ownership_ended|ownership_inserted, prev_ended_at, created_at).
  - import_jobs: add a preview-terminal status `awaiting_confirm` (between validating
    and persisting) + optional `confirmed_at`.
- **Worker (persistStage):** after validate, if preview mode → compute inventory
  (created vs attached counts + the set-replace impact) and stop at `awaiting_confirm`
  WITHOUT writing domain rows. On confirm → run persist, writing one import_changes
  row per change (the batch resolvers already know created-vs-attached per row; the
  ownership set-replace must log `ownership_ended` with prev_ended_at).
- **Endpoints:** POST /imports/:id/confirm (commit), /cancel (discard, already exists
  for pre-persist), /undo (reverse via ledger inside one tx: delete ownership_inserted,
  un-end ownership_ended, soft-archive created rows that nothing else references — per
  D.05 prefer archivedAt over hard delete; order ownerships→apartments→buildings→owners).
- **FE:** preview screen (inventory + validation errors) + אישור/ביטול; "בטל ייבוא"
  (undo) button on a completed import. "Pending until logout" = no timer auto-cancel.
- **Owner note "preview for all files":** Excel-only today; the preview/confirm pattern
  applies to the import pipeline. (Document upload already has create→PUT→finalize; the
  ghost-doc fix #3 is the analogous integrity gate there.)

## Session log

- This session: fixed #1, #2 (+SOLID renderer seam), #5. 4 commits on
  feat/in-app-notifications, all pushed, all reviewed (security PASS) + tested.
  Continuing the loop toward #6 (import preview+undo) → then #3 (ghost-docs) →
  #4 (scheduler, which also lights up signature-expiry + overdue + R2 sweeper).

## Decisions

- **D-A1 (SOLID signing):** extract `ISignedDocumentRenderer` (interface) + DI token
  `SIGNED_DOCUMENT_RENDERER`; the pdf-lib code becomes `PdfSignedDocumentRenderer`
  (one impl). `SignedDocumentService` = orchestration only (authz + data load +
  delegate to the renderer). Rationale: DIP/OCP — a future external e-sign system
  implements the same interface and is swapped in the module providers, with ZERO
  change to the service or controller. Also isolates the Hebrew-rendering concern
  into one swappable class.
- **D-A2 (permission fix):** the signed-doc endpoint gates on `owners.read`
  (coarse) + `resolveOwnerPiiFidelity === 'unmasked'` in the service — the SAME
  gate as POST /owners/:id/reveal-pii (manager always · agent iff view_owner_pii ·
  viewer never). Removes the engine `owners.reveal_pii` split-brain. FE button
  gates on `profile.view_owner_pii` (mirrors the owner-detail reveal button).

- **D-A3 (import UNDO — deferred-by-risk, NOT skipped lightly):** the undo
  DELETES/reverts org data (the ownership set-replace means undo must DELETE
  import-created ownerships AND REVIVE the prior ownerships the import ended).
  A bug here corrupts who-owns-what — the core regulated data. Building
  data-deletion logic UNSUPERVISED is the single highest-blast-radius thing in
  this roadmap. AND the PREVIEW (now shipped) already prevents the main case (a
  bad Excel never persists until a human confirms). So the undo's urgency
  dropped. DECISION: implement the `import_changes` ledger RECORDING (additive,
  safe) when resumed, but gate the DELETE/revive endpoint behind owner review
  before enabling — do not ship delete-logic unreviewed. Design is in
  "NEXT: import preview + undo" above. PROCEEDING to #3 (ghost-docs) meanwhile —
  lower-risk, API-only, and the actual NoSuchKey bug the owner hit.

## Blockers / skipped (need owner or visual confirmation)

- **B-A1 (Hebrew PDF "mess"):** owner reports the downloaded Hebrew cert looks like
  a mess. My run-based single-level bidi (manual reversal + per-run x) renders
  poorly in real viewers, and I cannot visually verify here (Read-tool rasterizer
  shows blank for the embedded font; Chrome PDF tab freezes CDP screenshots).
  RECOMMENDED FIX (deferred until visually confirmable): replace manual bidi with
  a proper approach — either (a) `bidi-js` (pure-JS UBA) to reorder each line then
  draw once, or (b) rasterize each Hebrew line to a PNG via a server-side canvas
  and embed the image (renders identically in every viewer, no font/bidi risk).
  Now ISOLATED behind ISignedDocumentRenderer (D-A1), so the fix is one class swap.
  SKIPPING active work on this until the owner can eyeball a candidate.
