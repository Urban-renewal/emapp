# Decision: Data-subject erasure vs. e-signature legal-retention

Status: PROPOSED — Gate-6. HELD for owner/legal confirmation.
Scope: P0.C1 (data-subject rights). Owner-approved compliance code.
Date: 2026-06-10.

## The conflict

The Israeli Privacy Protection Law (חוק הגנת הפרטיות) gives a data subject the
**right to erasure** ("right to be forgotten") of their personal data. EMAPP
holds owner PII: `national_id`, `phone`, `name` (pgcrypto-encrypted), plus
free-text `notes`/`email`.

At the same time, an owner who **signed a consent** for an urban-renewal project
(תמ"א 38 / פינוי-בינוי) has produced a **signature event** that is **legal proof**
the project relies on. Israeli e-signature practice + the project's own legal
posture require that signed-consent evidence be **retained** — it cannot simply be
destroyed on request, or the project loses the proof a given apartment owner
consented.

These two duties collide: erase the person's identity, but keep the signed
proof.

## The decision: crypto-shred / anonymize-in-place (the defensible middle path)

We do **NOT** hard-delete the owner row, and we do **NOT** cascade-delete the
`signatures` / `ownerships` rows. Instead, on erasure we:

1. **Crypto-shred the PII** on the `owners` row, in place:
   - `name_encrypted`, `national_id_encrypted`, `phone_encrypted` →
     overwritten with an **irreversible tombstone ciphertext** (a fresh
     `pgp_sym_encrypt('[erased]')`). The original plaintext is **gone** — it is
     not recoverable from the row, a DB dump, or a backup taken after the erase.
   - `name_hash`, `national_id_hash`, `phone_hash` → **NULL**. The subject can no
     longer be **found** by HMAC of their original national_id / phone / name.
   - `email`, `notes` → **NULL** (free-text fields that can carry PII).
2. **Mark the tombstone**: `erased_at` = now, `erased_by` = the acting manager.
   Also set `archived_at` so every existing archived-aware query/partial/unique
   index excludes the row.
3. **RETAIN** the `signatures` and `ownerships` rows **in place**, but REDACT the
   biometric content of the signature rows (see "Erasure-completeness HIGH #1"
   below): the SVG `signature_blob` is overwritten with a fixed tombstone and
   `signer_ip` / `signer_user_agent` are NULLed, while `document_hash`,
   `signed_at`, and the owner link are kept. After redaction the retained rows
   carry NO PII; they reference the owner by opaque UUID. The **legal validity
   survives** — the proof that _some owner_ (now redacted) signed _this document_
   at _this time_ is intact — while the **identity AND the biometric mark are
   redacted** (the owner UUID no longer resolves to a real person's PII, and the
   visual signature is gone).
4. **Write an append-only `erasure_log` row** (compliance ledger): owner id,
   actor, timestamp, the list of cleared **field categories** (names only,
   never values), and the **counts** of signatures/ownerships retained — the
   proof that we anonymized rather than deleted.
5. **Audit** the operation (`owner.erased`, ISO 27001 A.12.4).

After erasure the owner is **excluded from normal lists/search/detail** and is
**un-revealable** (the reveal-PII and data-export endpoints return 404 — there is
nothing left to reveal).

### Properties

- **Irreversible** — crypto-shred, not a reversible soft-delete. The original PII
  is destroyed.
- **Idempotent** — re-erasing an already-erased owner is a no-op (no second
  ledger row).
- **Project-integrity-preserving** — no cascade delete; the 100%-ownership-sum
  invariant and the signed-consent evidence chain are untouched.
- **Auditable** — both an `audit_log` row and a dedicated `erasure_log` ledger
  row, neither carrying PII values.

## Why not the alternatives

- **Hard-delete the owner + cascade signatures** — destroys the legal proof the
  urban-renewal project depends on. Rejected.
- **Refuse erasure for signers** — defeats the privacy-law right entirely.
  Rejected.
- **Soft-delete only (`archived_at`)** — today's behavior; the PII stays
  encrypted-but-recoverable, so it does NOT satisfy an erasure request. This is
  exactly the gap P0.C1 closes.

## Erasure-completeness — the two PII stores beyond the `owners` row

A security review of P0.C1 found that crypto-shredding only the `owners` row
left the subject's PII recoverable from **two other stores**. Both are now
resolved (HIGH #1 fixed in code; HIGH #2 verified + documented below).

### HIGH #1 (FIXED) — the biometric signature SVG blob

`signatures.signature_blob` holds the subject's **handwritten-signature SVG** —
a **biometric** PII artifact (the physical shape of their signature). It is NOT
pgcrypto-encrypted at rest and was RETAINED in cleartext after erasure, so the
subject's biometric mark survived the erase.

**Resolution (implemented):** on erasure, for **every** signature row tied to
the erased owner — within the SAME `withTenant` transaction as the owner
crypto-shred — we:

- **OVERWRITE** `signature_blob` with a small fixed non-PII tombstone
  (`SIGNATURE_BLOB_TOMBSTONE` = bytes of `[erased]`). The column is `NOT NULL`,
  so a constant non-empty buffer satisfies the constraint while the biometric
  content is destroyed.
- **NULL** the forensic `signer_ip` and `signer_user_agent` (both nullable).
- **RETAIN** the row, `document_hash`, `signed_at`, and the owner link.

Legal validity now rests on the **document hash + signing-event metadata**, NOT
on the visual SVG: the proof that _some owner_ (now redacted) signed _this
document_ at _this time_ is intact. The count of redacted signatures is recorded
in `erasure_log.signatures_retained` and the audit `afterState`
(`signaturesRetained`) — **count only, never any PII value**. The redacted
field-category names (`signature_blob`, `signer_ip`, `signer_user_agent`) are
added to `cleared_fields`.

### HIGH #2 (VERIFIED — no long-term store) — the R2 import source file

Owners imported via the Excel pipeline originate from a source spreadsheet that
contains **cleartext** `national_id` / `phone` / `name`, stored in R2 keyed by
`import_jobs.file_r2_key`.

**Finding: the import source file is NOT a long-term store — it is purged from
R2 once the import reaches a terminal state.** The existing post-import
lifecycle (`packages/db/src/helpers/import-bytes.ts` → `purgeImportBytes`, the
"v8 §v8-S1 R2 retention" flow) is invoked by the worker's terminal-state path
(`apps/worker/src/handlers/import-job.handler.ts`) for every job that reaches
`done` / `failed` / `cancelled`, and by the API cancel path (v8.5 fix). It
issues an R2 `DeleteObject` for `file_r2_key` and stamps `file_deleted_at`
(migration 0032, whose CHECK only permits `file_deleted_at` on terminal jobs).
A scheduled sweeper retries any purge that failed (R2 outage), so the deletion
is durable, not best-effort-once.

**Retention window:** the cleartext source file exists in R2 only from upload
until the import reaches a terminal state — i.e. the duration of one import run
(seconds-to-minutes for normal files; bounded by the worker's processing of the
job, not by any per-owner retention). After that the bytes are gone. Therefore
a per-owner erasure does **not** need to (and structurally **cannot**) surgically
edit a multi-owner Excel: by the time an owner exists in the domain tables to be
erased, the source file that produced them has already been (or is being)
purged by the import lifecycle. Erasure-completeness for import-origin owners
**depends on this import-purge lifecycle**, which is verified above.

We deliberately do **NOT** delete an import file on single-owner erasure: a
source spreadsheet is multi-owner and a single subject's erasure must not
destroy the other owners' import provenance. The file is governed by the
import-purge lifecycle (`file_deleted_at` / `purgeImportBytes`), not by the
data-subject erase path.

## Open items — flagged for owner / legal confirmation (Gate-6)

- Confirm the **retention basis** (which statute / project agreement clause)
  that justifies keeping signed-consent evidence (the retained signature event:
  document hash + `signed_at` + owner link) over the erasure right, so the
  ledger's legal footing is documented.
- Confirm whether erasure should also propagate to **derived exports** already
  produced (xlsx/PDF) — currently out of scope (those are point-in-time
  artifacts already delivered).
