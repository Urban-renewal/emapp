-- v8 §v8-S3 — owners.name PII encryption (single-migration variant,
-- safe for MVP-scale dev/staging DBs where downtime is acceptable).
--
-- BACKGROUND
--   `owners.name` was stored cleartext while `national_id` + `phone`
--   were pgcrypto-encrypted. Half-encrypted PII is the worst of both:
--   a Provider-Admin BYPASSRLS scan / SQL-injection / wide-grant
--   misconfig returns every owner name across all orgs. ISO A.18.1.4
--   data-minimisation + Israeli privacy law require name to be
--   protected at the same posture as national_id.
--
-- STRATEGY
--   This is an ATOMIC migration:
--     1. ADD `name_encrypted bytea` + `name_hash bytea` (nullable
--        initially so the backfill UPDATE works).
--     2. BACKFILL via `pgp_sym_encrypt` + `hmac` using `current_setting`
--        for the encryption key + hash key (set as session GUCs by
--        the migrator wrapper — see `packages/db/scripts/migrate.ts`).
--     3. ALTER `name_encrypted` + `name_hash` to NOT NULL (now safe).
--     4. DROP cleartext `name` + DROP the unused `idx_owners_org_name`
--        (he_il_icu Hebrew-sort index) — it operated on the cleartext
--        column we just removed.
--
-- PRECONDITIONS (enforced by the migrator wrapper)
--   - `app.encryption_key` GUC is set to env.PII_ENCRYPTION_KEY
--   - `app.pii_hash_key`   GUC is set to env.PII_HASH_KEY
--   The migrator's `scripts/migrate.ts` runs `SELECT set_config(...)`
--   before applying migrations. Without these, the backfill fails LOUD
--   (current_setting returns empty string → pgp_sym_encrypt with
--   empty key throws). FAIL-FAST is the right outcome — encrypting
--   with an empty key would be catastrophic.
--
-- ROLLBACK PLAN
--   Inverse migration would need to DECRYPT each row's name back into
--   a new `name` column. Practical only with the key still available.
--   For MVP we accept this is a one-way migration; production rollout
--   in a multi-pod env would use a 3-migration zero-downtime variant
--   (see OPEN-ITEMS-v8.md §v8-S3 plan).
--
-- IMPACT ON SORT
--   The dropped `idx_owners_org_name` was used for he_il_icu Hebrew
--   sort. Per the v8-S3 inventory NO code path currently ORDER-BYs
--   `owners.name`; all listings use keyset on (created_at, id).
--   If future UI needs Hebrew-sorted names, do app-side decrypt+sort
--   (Phase 4 FE can render names with a memoized decrypt per page).

-- Step 1: additive columns.
ALTER TABLE owners ADD COLUMN name_encrypted bytea;
ALTER TABLE owners ADD COLUMN name_hash      bytea;

-- Step 2: backfill. WHERE name IS NOT NULL is defensive; the
-- existing column is NOT NULL so all rows match.
UPDATE owners
   SET name_encrypted = pgp_sym_encrypt(name, current_setting('app.encryption_key')),
       name_hash      = hmac(name::bytea, current_setting('app.pii_hash_key')::bytea, 'sha256')
 WHERE name_encrypted IS NULL;

-- Step 3: tighten the new columns.
ALTER TABLE owners ALTER COLUMN name_encrypted SET NOT NULL;
ALTER TABLE owners ALTER COLUMN name_hash      SET NOT NULL;

-- Step 4: drop the old cleartext column + its now-orphan index.
DROP INDEX IF EXISTS idx_owners_org_name;
ALTER TABLE owners DROP COLUMN name;

-- Optional: an index on (org_id, name_hash) supports future "find
-- owner by exact name" lookups (using the HMAC hash as the equality
-- key). Not currently used by any code path; landed alongside the
-- schema change so a Phase 4 search feature can use it without
-- another migration.
CREATE INDEX IF NOT EXISTS idx_owners_org_name_hash
  ON owners (org_id, name_hash)
  WHERE archived_at IS NULL;
