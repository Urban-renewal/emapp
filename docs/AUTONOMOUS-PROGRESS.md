# Autonomous progress + decisions log

Running the roadmap autonomously (owner away). Logging every decision/blocker.
Order = owner's: import-preview+undo → lifecycle/scheduler → notifications+settings,
plus the cross-cutting directives: **SOLID/modular signing** (swappable for a
future external e-sign integration) and the **Hebrew signed-PDF "mess"**.

## Verified gap backlog (from the 4 independent audits)

1. ✅ Signed-doc 500 on non-Hebrew names — FIXED (encodeSafe) + pushed.
2. Signed-doc permission split-brain (FE button ungated + BE engine-gate ≠ legacy
   view_owner_pii) — IN PROGRESS this session.
3. Ghost documents / NoSuchKey (no upload-status column → 5 surfaces serve
   byte-less docs; worst: signature recorded against never-stored bytes).
4. No scheduler at all → R2 PII-byte leak, signature-expiry never finalizes/notifies,
   "overdue" inert. Foundational.
5. task_assigned not fired on manager-create-with-assignees path.
6. Import: dryRun dead-ends; ownerships persist via destructive set-replace;
   undo impossible (no change-ledger). The preview+undo build.

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
