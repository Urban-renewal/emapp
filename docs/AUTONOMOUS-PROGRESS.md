# Autonomous progress + decisions log

Running the roadmap autonomously (owner away). Logging every decision/blocker.
Order = owner's: import-preview+undo → lifecycle/scheduler → notifications+settings,
plus the cross-cutting directives: **SOLID/modular signing** (swappable for a
future external e-sign integration) and the **Hebrew signed-PDF "mess"**.

## Verified gap backlog (from the 4 independent audits)

1. ✅ Signed-doc 500 on non-Hebrew names — FIXED (encodeSafe) + pushed (7f55b3c).
2. ✅ Signed-doc permission split-brain — FIXED + SOLID refactor (b6f1602).
3. 🟢 Ghost documents / NoSuchKey — DOWNLOAD path (843aa4e) + SIGNATURE
   create+preview (4deb3d5, the audit's WORST finding F5) both FIXED + verified.
   Remaining: tenant-portal + contractor-portal LIST surfaces (lower value —
   they only LIST ghosts, never serve bytes; same uploaded_at filter pattern).
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

## Session tally (this autonomous run — 13 commits, all pushed + verified)

- ✅ #1 signed-doc 500-on-non-Hebrew-names (7f55b3c)
- ✅ #2 permission split-brain + SOLID renderer seam (b6f1602)
- ✅ #5 task_assigned on create-with-assignees (26963a6)
- ✅ #6 import PREVIEW→confirm — backend + FE + E2E (c23cb1b/ef7d24a/b57c8a2)
- ✅ #3 ghost-docs / NoSuchKey — ALL 5 surfaces gated + E2E (843aa4e org-download,
  4deb3d5 signature-create+preview = audit's worst F5, 370bedd portal+contractor)
- Each: typecheck+lint+tests green, migrations 0048/0049 applied to local DB.
  REMAINING (designed, not yet built): #4 scheduler (signature-expiry transition +
  overdue + R2 PII-byte sweeper — the "what happens over time" answer); #6 undo
  (deferred-by-risk, D-A3); B-A1 Hebrew render (needs owner visual confirmation).
  Gate-6 migrations (0048/0049) await owner merge.

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

## 2026-06-06 — SYSTEM-STATE HIGH findings re-verified (owner away, per-recommendation)

Worked the H1→H4 recommendation list. CRITICAL outcome: **two of the four HIGHs were
over-claimed by the audit agents** — caught by tracing the actual service bodies before
"fixing". (Owner hates false findings; verification before action paid off.)

- **D-A4 (H1 REFUTED — do NOT "fix"):** the capability-matrix audit said agents can
  update projects / set ownerships / manage contractors / mint+revoke share links with
  no gate. FALSE — every write calls `this.requireManager(user)` (projects 456/496,
  ownerships 242, contractors 101/146/193, shares 193/242/280). The audit saw the coarse
  engine grant + the missing `requireAgentCapability` and stopped — it never read the
  service body where `requireManager` (a stricter gate) blocks agents outright. The
  `if(role==='agent')` lines it cited are scope checks in READ methods. Net: manager-only
  today, as D.17 intends. Only LOW residue: the engine coarse grant is wider than the
  effective permission (redundant, not exploitable). No code change. SYSTEM-STATE-AUDIT.md
  H1 downgraded to REFUTED with file:line evidence.
- **H3 FIXED (provider login-failure audit):** added best-effort `recordLoginFailure`
  to provider-auth.service.ts — both failure branches (already-locked window + verify)
  now write a `login_failed` provider_audit_log row. `metadata.passwordValid` separates
  stolen-password+MFA-block from spray, no password stored, no client oracle, count-bump
  NOT gated on the audit (lockout stays robust if audit table is down). Zero schema change
  (action_type free-text matches 0034 CHECK). typecheck+lint green. Test: blocked on the
  M4 provider-seed gap (no in-suite provider user; verifying test is env-gated). Mirrors
  3 existing audited paths exactly.
- **H2 corrected to PARTIALLY REAL (not fixed yet):** the in-tx Resend loop
  (calendar-email.service.ts:199-257) + spurious 'update' on non-calendar edits
  (tasks.service.ts:482) are real; the "idempotency/rollback bug" framing is wrong (the
  dispatch is after-tx fire-and-forget; ICS UPDATE re-send is intended). Recommended fix
  (move sends out of the calendar tx + gate 'update' on a real calendar-field delta) is
  documented in the audit doc — deferred (moderate surgery on a working path; lower value
  than H3 now that the framing is corrected).
- **H4 (no scheduler):** unchanged — foundational, owner-flagged "skip if too complex".
  Stays deferred; the real residue is R2-purge-retry (PII byte retention) + stuck-queued
  recovery, both designed in "NEXT" above.
- **M2 RECLASSIFIED (export authz) — do NOT flip the gate, owner decision needed.**
  Looked like a clean 1-line tighten (`projects.read`→`export.run`). It is NOT: agent-
  scoped MASKED export is intended per D.54/B.S10 + the composer tests, but the engine
  catalog excludes export.run from Agent — a genuine contradiction across catalog /
  controller / FE / D.54. Tightening would silently 403 the agent HTTP path while the
  composer unit tests (which bypass the controller) stay green. Verified, documented in
  SYSTEM-STATE-AUDIT.md M2, surfaced for owner. THIRD audit finding corrected by tracing
  the actual code+tests before acting.

## ⚖️ Owner decisions queued (do NOT resolve unilaterally — surfaced, not actioned)

These came up during the autonomous pass and are policy/spec choices, not mechanical fixes:

1. **Export authz policy (M2).** Is agent-scoped masked export IN or OUT? Is viewer export
   IN or OUT? Today the controller allows all three (projects.read); the role catalog,
   D.54, the FE button, and the controller comment disagree with each other. Pick one
   answer, then align catalog + controller gate + FE gate + D.54. (See SYSTEM-STATE M2.)
2. **H2 calendar email — apply the deferred fix?** Move the Resend loop out of the
   calendar tx + gate 'update' on a real calendar-field delta. Real but moderate surgery
   on a working path; low MVP impact. Recommend yes, but after a green smoke. (SYSTEM-STATE H2.)
3. **H4 scheduler — build it?** Foundational; unblocks signature-expiry finalize/notify,
   overdue firing, AND the R2 PII-byte purge-retry (the real retention leak). Owner flagged
   "skip if too complex" — confirm whether to invest now or post-MVP.
4. **Import UNDO delete-endpoint (D-A3).** Ledger recording is safe/additive; the
   DELETE/revive endpoint touches core who-owns-what data and is gated behind owner review.
5. **Hebrew signed-PDF render (B-A1).** Needs a visual eyeball on a candidate (bidi-js or
   rasterize-to-PNG) — isolated behind ISignedDocumentRenderer, one class swap.

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
