# Runbook — PR #498 sensitive-doc encryption (the pre-launch prod op)

**What it closes:** ~750 sensitive docs (national_id, נסח טאבו) stored plaintext + served unencrypted — a
real PII-breach exposure. The launch blocker. **Do NOT merge #498 as a casual PR** — the migrations add a
CHECK ("sensitive ⇒ encrypted") + derive-on-insert; applied while the 750 existing docs are still plaintext,
they break access to those docs. The **backfill must run FIRST**, then the migrations, then the merge.

**Who runs what:** the OWNER runs the irreversible prod steps (secret provisioning, the live-data backfill,
the prod migration) — these are the genuine-gate set. The lead PREPARES + verifies each step on staging and
hands the exact commands. Nothing here is run unattended on prod by an agent.

## Prerequisites (owner)

1. **`DOC_ENCRYPTION_KEY` provisioned in prod secrets** (Infisical prod) — the AES key the backfill encrypts
   with. Without it the re-encrypt can't run. (Genuine-gate: KMS/secret provisioning.)
2. **A fresh prod DB snapshot/backup** taken immediately before step B — this is the rollback anchor.
3. Confirm staging mirrors prod schema (dry-run on staging first, below).

## The sequence (run on STAGING end-to-end first, then prod)

### A. Dry-run the backfill — REPORT only, commits nothing

The remediation sweep + re-encrypt are **dry-run by default**. Run the report and read the counts.

- `packages/db/scripts/reencrypt-sensitive-docs.ts` (re-encrypt existing plaintext sensitive bytes → sets
  `bytes_encrypted=true`).
- The FL-5 remediation sweep (re-types unambiguous נסח/tabu → `land_registry`, derives `sensitive=true`,
  TURN-ON only, idempotent, org-scoped via withTenant/RLS).
- **Verify the report:** the count of docs to re-encrypt ≈ the known ~750; no cross-org rows (RLS-scoped);
  the sample is metadata-only (no filename/content/PII).

### B. Apply the backfill (dryRun=false) — re-encrypts the existing sensitive docs

- Run with the explicit apply flag. It re-encrypts each plaintext sensitive doc + writes a metadata-only
  audit row per doc. Idempotent — a re-run is a no-op.
- **VERIFY before proceeding:** `SELECT count(*) FROM documents WHERE sensitive=true AND bytes_encrypted=false;`
  → **must be 0**. (No sensitive doc remains plaintext.) If non-zero, STOP and investigate — do NOT migrate.

### C. Apply the migrations (only after B verifies 0 plaintext-sensitive)

- `0080_sensitive_docs_encrypted_check.sql` (CHECK: sensitive ⇒ encrypted) + `0081_sensitive_docs_derive_
encrypted_on_insert.sql` (derive-on-insert). These now pass because B left zero plaintext-sensitive rows.

### D. Merge #498 to main + deploy

- The code enforces encrypt-at-rest on new uploads + never plain-serves sensitive (incl. the public-sign
  preview path). Merge + deploy.

### E. Post-verify (real-Chrome, as the lead)

- Download a sensitive doc → served via the decrypt-stream (encrypted) path, never a plain presign.
- The public `/sign/:token` preview of a sensitive doc → NOT plain-presigned (the cross-owner leak is closed).
- Spot-check the audit rows exist; counts consistent.

## Rollback

If B or C fails: restore the prod snapshot from the prerequisite backup. The backfill is idempotent + the
migrations are additive constraints (droppable), but the snapshot is the guaranteed recovery. Do NOT leave
the system half-migrated (constraint applied while some docs are plaintext).

## Sequencing vs #512

Land #512 (consent registry — additive, low-risk) independently and first; it does not depend on #498. #498
is the separate, heavier pre-launch op above. Both stay owner-gated until executed.
