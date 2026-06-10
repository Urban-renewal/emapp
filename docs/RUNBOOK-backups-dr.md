# RUNBOOK — Backups & Disaster Recovery (EMAPP)

> **Audience:** EMAPP operators / on-call (the 2-developer team) during an
> incident. This is an **operator-followable** procedure, not a design essay.
> When the DB is on fire, open this file and execute top to bottom.
>
> **Scope:** the PostgreSQL primary (Neon), the object store (Cloudflare R2),
> and — the single most-missed dependency — the **PII encryption keys in
> Infisical** without which a restored database is unreadable ciphertext.
>
> **Status:** P0.B3. Documentation + restore-drill procedure. NO new DB schema.
> A read-only posture surface ships alongside at `/provider/backups`.

---

## 0. TL;DR — the three things that must all survive an incident

A restore is only successful if **all three** of these come back together. Any
one missing = data loss or unreadable data.

| #   | Asset                                                          | Where it lives                      | Recovery mechanism                                              |
| --- | -------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| 1   | **The database** (rows, including encrypted PII columns)       | Neon (PostgreSQL 16, EU/Frankfurt)  | Neon PITR / branch-restore (§3), or `pg_dump`/`pg_restore` (§4) |
| 2   | **PII encryption keys** — `PII_ENCRYPTION_KEY`, `PII_HASH_KEY` | **Infisical** (secrets manager)     | §5 — **MUST be recoverable or the DB ciphertext is worthless**  |
| 3   | **Uploaded files** (owner docs, signed PDFs)                   | Cloudflare R2 (`emapp-prod` bucket) | R2 object versioning + lifecycle (§6)                           |

> **⚠️ CRITICAL — read §5 before you trust any DB restore.** EMAPP encrypts
> `national_id`, `phone`, owner names, and signature material at rest with
> pgcrypto, keyed by `PII_ENCRYPTION_KEY` / `PII_HASH_KEY` held in Infisical
> (NOT in the database). Restoring the database **without** the matching keys
> gives you rows of undecryptable bytes. The keys are part of the backup
> surface, full stop.

---

## 1. RTO / RPO statement

These are the targets the procedures below are designed to meet. Treat them as
the commitment to measure the restore drill (§7) against.

| Metric                            | Target                                      | Basis                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** (max data loss)           | **≤ 5 minutes**                             | Neon PITR is continuous (WAL-based) within the retention window — recovery to any second. The 5-min figure is the practical bound on "how stale is the latest restorable point", not a snapshot cadence. |
| **RTO** (time to restore service) | **≤ 1 hour** (DB), **≤ 2 hours** end-to-end | Neon branch-restore is minutes; the rest of RTO is re-pointing `DATABASE_URL`, redeploying the Railway services, and verifying PII decryption (§3, §8).                                                  |
| **PII-key RTO**                   | **0 (must already be in Infisical)**        | Keys are never derived from a backup; they must persist independently. If lost, RTO is effectively infinite (data unrecoverable). See §5.                                                                |

> These targets assume the Neon **retention window covers the incident**. If the
> corruption/deletion is older than the retention window (§2), PITR cannot reach
> it — the `pg_dump` archive fallback (§4) is the only path. Take periodic dumps
> precisely so a beyond-window incident is still recoverable.

---

## 2. Neon automatic backups, PITR & the retention window

EMAPP's primary is a **Neon** PostgreSQL 16 project per environment
(`emapp-prod`), EU/Frankfurt region (SETUP-EXTERNAL-SERVICES §2).

**What Neon gives us automatically (no cron, no script):**

- **Continuous PITR (point-in-time recovery)** — Neon retains write-ahead log
  (WAL) history, so you can create a new branch anchored to **any timestamp or
  LSN** inside the retention window. This is the primary recovery mechanism.
- **No snapshot job to babysit** — there is no nightly `pg_dump` cron we own for
  Neon's own restore path; recovery is branch-from-history.

**Retention window — VERIFY THE ACTUAL VALUE, do not assume:**

- Neon's history-retention is a **project setting** (plan-dependent; commonly a
  small number of days on lower tiers, longer on paid tiers). The runbook is
  written against a **documented N-day window** — fill in the real number:
  - Console → the `emapp-prod` project → **Settings → Storage / History
    retention** → read the configured days.
  - **Record it here when confirmed:** `RETENTION_DAYS = <N> days` (prod).
- The `/provider/backups` status page surfaces this same documented number so
  operators and (audited) provider staff see one honest figure.

> **Action item for go-live:** set prod history retention to the **longest the
> plan allows** (target ≥ 7 days) and pin the exact number both here and on the
> status page. A short window silently shrinks your real RPO for slow-burn
> incidents (e.g. a bad migration noticed days later).

---

## 3. RESTORE — primary path: Neon branch-restore (PITR)

Use this when the data loss / corruption timestamp is **within the retention
window** (§2). This is the fast path and meets the RTO target.

> Do this in the Neon console (or `neonctl`). Decide the **target timestamp** =
> the last known-good moment, i.e. just **before** the bad event (a wrong
> migration, an erroneous bulk delete, corruption onset).

### 3.1 Steps

1. **Freeze writes / declare incident.** Put the app into a maintenance posture
   so you are not racing live writes. (Suspend at the Railway service level, or
   flip the app to read-only if available.) Note the incident time.
2. **Identify the target time** `T = <YYYY-MM-DDTHH:MM:SSZ>` — the last
   known-good instant. Prefer a few seconds **before** the bad event.
3. **Create a restore branch** in Neon:
   - Console: project `emapp-prod` → **Branches → New branch → "Restore from a
     point in time"** → pick `T` → name it `restore-<incident>-<date>`.
   - or CLI: `neonctl branches create --project-id <id> --name restore-<incident> --timestamp <T>`
4. **Get the new branch's connection strings** (pooled + direct + provider role)
   — mirror the three vars EMAPP uses: `DATABASE_URL`, `DATABASE_MIGRATE_URL`,
   `DATABASE_URL_PROVIDER` (SETUP-EXTERNAL-SERVICES §2).
5. **Sanity-check the restored data on the branch BEFORE cutover** — connect with
   the provider role and confirm the bad event is gone and PII decrypts (§8).
   Decrypting here proves the §5 keys still match this data.
6. **Cut over:** update the three `DATABASE_URL*` values in **Infisical**
   (prod) to the restore branch, then redeploy the Railway API + Worker so they
   pick up the new env. (Neon also supports promoting/swapping the branch to be
   the primary — either re-point the URLs, or promote the branch; pick one and
   record which in the incident log.)
7. **Un-freeze writes**, run the post-restore verification (§8), close the
   incident, and schedule deletion of the now-stale old branch after a safe
   hold period.

### 3.2 Notes

- Branch-restore does **not** restore R2 objects (§6) or the Infisical keys
  (§5) — those are independent assets. A full DR is all three.
- If you re-point URLs rather than promote, keep the original branch read-only
  for forensics until the incident is signed off.

---

## 4. RESTORE — fallback path: `pg_dump` / `pg_restore`

Use this when:

- the incident is **older than the Neon retention window** (PITR can't reach
  it), **or**
- you need a copy **outside Neon** (provider-independence / regional outage /
  "export everything" obligation).

This path depends on **periodic logical dumps existing**. Neon's own PITR does
not produce a portable file — so to have this fallback you must be taking dumps
on a schedule and storing them durably (see §4.3).

### 4.1 Take a dump (the thing you must already be doing on a schedule)

```bash
# Full custom-format dump of prod (run with Infisical so the URL is injected;
# NEVER paste the real connection string into a shell history).
# Use the DIRECT (non-pooled) URL — pg_dump dislikes PgBouncer pooling.
infisical run --env=prod -- \
  pg_dump --format=custom --no-owner --no-privileges \
    --file="emapp-prod-$(date -u +%Y%m%dT%H%M%SZ).dump" \
    "$DATABASE_MIGRATE_URL"
```

- `--format=custom` → compressed, `pg_restore`-selectable.
- The dump contains the **encrypted PII bytes as stored** — it is NOT
  plaintext, but it IS sensitive (ciphertext + structure). Store it encrypted
  and access-controlled (§4.3). It is still useless to an attacker without the
  §5 keys — and useless to **you** without them either.

### 4.2 Restore a dump into a fresh Neon branch / database

```bash
# 1. Create an empty target (a fresh Neon branch, or a new DB on the project).
# 2. Ensure pgcrypto exists on the target BEFORE restore:
infisical run --env=prod -- \
  psql "$DATABASE_MIGRATE_URL" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'

# 3. Restore.
infisical run --env=prod -- \
  pg_restore --no-owner --no-privileges --clean --if-exists \
    --dbname="$DATABASE_MIGRATE_URL" \
    emapp-prod-<timestamp>.dump
```

- After restore, run `pnpm --filter @emapp/db db:migrate` only if the dump
  predates the current schema head — to forward the schema. (A dump taken at
  schema head needs no migration.)
- **Verify PII decryption (§8)** before declaring success. If decryption fails,
  the §5 keys in the **current** Infisical env do not match the keys that were
  live when the dump was taken — see §5.4.

### 4.3 Where dumps must live (so this fallback is real)

- Store dumps in a **durable, access-controlled, versioned** location separate
  from the Neon project — the natural choice here is a dedicated **R2 bucket**
  (e.g. `emapp-backups`) with versioning + lifecycle (§6), or another cloud's
  object store for provider-independence.
- Encrypt at rest. Restrict to the provider/ops principals only.
- **The dump and the §5 keys must be recoverable together** but **stored
  separately** (don't put the keys inside the dump bucket — that defeats the
  separation that makes the ciphertext safe).

---

## 5. ⚠️ CRITICAL — PII encryption keys must be recoverable (the keystone)

This is the section most backup plans forget and the one that turns a "we have
backups" into "we have unreadable backups".

### 5.1 The dependency

EMAPP encrypts PII **at rest in PostgreSQL** with pgcrypto:

- `PII_ENCRYPTION_KEY` — symmetric key for `pgp_sym_encrypt` /
  `pgp_sym_decrypt` of `national_id`, `phone`, owner names, signature material.
- `PII_HASH_KEY` — HMAC key for the deterministic lookup hashes
  (`name_hash`, etc., via `hmac(..., 'sha256')`).

Both are injected at runtime as GUCs (`app.encryption_key`, `app.pii_hash_key`)
inside `withProvider` / `withTenant`, sourced from **Infisical** — they are
**NOT stored in the database**. (See `packages/db` migration `0033`,
SETUP-EXTERNAL-SERVICES §1.)

### 5.2 Why a DB restore alone is worthless

A Neon branch-restore or a `pg_restore` brings back the **ciphertext**. Decryption
requires the **exact same** `PII_ENCRYPTION_KEY` / `PII_HASH_KEY` that were live
when the data was written. From SETUP-EXTERNAL-SERVICES §1:

> `PII_ENCRYPTION_KEY` must be **identical across the lifetime of an
> environment** — rotating it makes existing encrypted PII unreadable.

So: **restored DB + wrong/missing keys = permanent PII data loss**, even though
every row "came back".

### 5.3 Make the keys recoverable — the requirement

1. **Keys live in Infisical** (`prod` env) and Infisical is the source of truth.
   Infisical itself must therefore be part of your DR thinking — confirm
   Infisical's own backup/availability and that you (the org) can recover the
   workspace.
2. **Hold an independent, encrypted, offline escrow** of `PII_ENCRYPTION_KEY`
   and `PII_HASH_KEY` (and the other irreplaceable secrets:
   `SIGNATURE_TOKEN_SECRET`, `JWT_SECRET`). Recommended: a sealed copy in a
   second secrets vault or an encrypted offline medium held by the org's
   security owner. **If Infisical is unavailable AND there is no escrow, the
   prod data is unrecoverable.** This is a go-live blocker, not a nice-to-have.
3. **Never** rotate `PII_ENCRYPTION_KEY` without a planned re-encryption
   migration. A rotation event must be captured in the escrow (old + new) until
   all data is re-encrypted, or old backups become undecryptable.

### 5.4 If a restore decrypts to garbage

Decryption failure on a restored DB means the live `PII_ENCRYPTION_KEY` ≠ the
key that wrote the data. Do **not** overwrite or rotate anything. Recover the
**original** key from the §5.2 escrow / the Infisical history for the env, set
it in the restored env, and re-verify (§8). The data is fine — the key is the
variable.

---

## 6. R2 object storage (uploaded docs & signed PDFs)

Owner-uploaded documents and signed-certificate PDFs live in Cloudflare **R2**
(`emapp-prod` bucket, via `IStorageProvider`). A DB restore does **not** restore
these — they are an independent asset.

**Configure these on the prod bucket (do it at go-live, verify in the drill):**

- **Object versioning** — so an overwrite/delete leaves a recoverable prior
  version. Without versioning, a malicious or accidental delete is permanent.
- **Lifecycle rules** — expire **noncurrent** versions after a retention period
  consistent with the data-retention policy (don't keep prior versions forever;
  don't expire them so fast that recovery is impossible). Align the noncurrent
  retention with the Neon `RETENTION_DAYS` so DB and object recovery windows
  match.
- **Separate backups bucket** (`emapp-backups`) for the §4 `pg_dump` archives,
  versioned + lifecycle'd, access-restricted to ops only.

**R2 restore of a single object:** restore the prior version via the R2 console
/ S3 API (`list-object-versions` → copy the desired version id back over the
current key). For a bulk/ransomware event, restore noncurrent versions across
the affected prefix.

> **PII note:** R2 objects can contain PII (uploaded owner docs). The same
> access-control and "never log the bytes" rules apply to backup copies. The R2
> PII-byte purge-on-archive path (separate retention concern, see
> SYSTEM-STATE-AUDIT) is about deletion, not backup — don't conflate them.

---

## 7. Restore DRILL — proving restore works (not assuming it)

> An untested restore is, for a PII database, **as dangerous as no backup** —
> it gives false confidence. Run this drill on a schedule and record the result.
> A restore you have never executed is a hypothesis.

**Cadence:** at minimum **quarterly**, and after any change to the DB topology,
the encryption keys, or the Neon plan/retention setting.

\*\*Drill checklist (record each run in the incident/ops log with date + operator

- measured RTO):\*\*

* [ ] **1. Pick a target time** `T` inside the current retention window.
* [ ] **2. Branch-restore** prod to `T` into a throwaway branch (§3) — **time it**
      (this is your measured RTO contribution).
* [ ] **3. Connect** to the restore branch with the provider role.
* [ ] **4. Row sanity:** counts on `owners`, `projects`, `signature_requests`
      are plausible vs. live.
* [ ] **5. ⚠️ PII DECRYPTION CHECK (the whole point):** decrypt a known
      `national_id` / `phone` / owner name on the restored branch using the
      live Infisical keys (§8) and confirm it returns **correct plaintext**.
      This proves the §5 key dependency holds end-to-end. **If this fails the
      drill FAILS** — the backup is unreadable.
* [ ] **6. R2 version check:** confirm a prior version of a test object is
      recoverable from the prod bucket (§6).
* [ ] **7. `pg_dump` fallback check (at least annually):** take a dump (§4.1),
      restore it into a fresh branch (§4.2), and repeat steps 4–5 against it.
* [ ] **8. Record** measured RTO + RPO-at-T and compare to the §1 targets.
      File any gap as an action item.
* [ ] **9. Tear down** the throwaway branch and any test dump.

> **The drill is FAILED if PII does not decrypt**, even if every row returned.
> That failure means the §5 escrow / key story is broken — fix it before prod.

---

## 8. Post-restore verification (run after EVERY real restore and in the drill)

```bash
# Connectivity + schema head present.
infisical run --env=prod -- \
  psql "$DATABASE_URL_PROVIDER" -c '\dt' | head

# Row plausibility (provider role bypasses RLS for this ops check only).
infisical run --env=prod -- \
  psql "$DATABASE_URL_PROVIDER" \
    -c 'SELECT count(*) FROM owners; SELECT count(*) FROM projects;'
```

**PII decryption proof** — the load-bearing check. Run it through the app path
(an audited provider read of a known owner via the normal `withProvider`
decrypt path) OR a controlled SQL check that sets the GUC from the live key,
mirroring `0033`:

- Confirm a known owner's `national_id` / `phone` / name decrypts to the
  **expected** plaintext.
- If it returns NULL / garbage / errors → **STOP**, you have a key mismatch
  (§5.4), not a data problem. Recover the original key; do not rotate.

**Service-level checks after a real cutover:**

- [ ] Railway API + Worker redeployed against the restored `DATABASE_URL*`.
- [ ] A provider login + an audited tenant read succeeds (auth + RLS intact).
- [ ] A resident OTP login + a document download succeeds (R2 + decrypt path).
- [ ] Incident logged; stale branch retained for forensics, then scheduled for
      deletion.

---

## 9. Business continuity & Israeli high-tier Data-Security regulation

EMAPP holds residents' **national IDs, phones, names and signatures** — under
the Israeli Privacy Protection (Data Security) Regulations this is a **high
security-level** database. The regulations expect, among other controls:

- **Backup of the database and the ability to restore it** — and, critically,
  that restorability is **periodically tested** (the §7 drill is how we satisfy
  the "tested, not assumed" expectation).
- **Documented business-continuity / recovery procedure** — this runbook,
  reviewed and dated, with named RTO/RPO (§1).
- **Protection of the backup media** at the same security level as the live
  data — hence the encrypted, access-controlled dump storage (§4.3), the
  separation of keys from ciphertext (§5), and "never log PII bytes" extending
  to backup copies (§6).
- **Audited access** to recovery actions — provider-tier restore actions are
  performed by MFA'd provider staff under the AccessReasonGate, and the
  `/provider/backups` status surface is itself an audited provider page.

> This runbook is the operational evidence behind the backup/DR control. Keep it
> current: review at least each time retention, keys, or topology change, and
> record drill outcomes (§7) as the proof of a _working_ restore.

---

## 10. Quick incident index

| Situation                                               | Go to                                             |
| ------------------------------------------------------- | ------------------------------------------------- |
| Bad delete / migration, within retention                | §3 (Neon branch-restore)                          |
| Incident older than retention, or need an off-Neon copy | §4 (`pg_dump`/`pg_restore`)                       |
| Restored data decrypts to garbage                       | §5.4 (key mismatch — recover original key)        |
| Lost / unsure about the PII keys                        | §5 (escrow — possibly unrecoverable: escalate)    |
| Deleted / overwritten uploaded file                     | §6 (R2 object versioning)                         |
| "Have we proven restore works?"                         | §7 (run the drill)                                |
| What do we promise?                                     | §1 (RTO/RPO)                                      |
| What's the retention window?                            | §2 (verify in Neon console; pin `RETENTION_DAYS`) |
