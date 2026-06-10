-- S3a — owner SHELLS. An owner may be created as a skeleton (Tabu/parcel
-- import) with NO name and NO national_id; a field worker enriches the
-- record later. Drop the NOT NULL on the two encrypted PII columns so a
-- pure-shell INSERT (both NULL) is accepted. The per-org national_id
-- unique index (owners_org_natid_unique_active) ignores NULLs, so multiple
-- no-national_id shells coexist without colliding.
ALTER TABLE owners ALTER COLUMN name_encrypted DROP NOT NULL;
ALTER TABLE owners ALTER COLUMN national_id_encrypted DROP NOT NULL;
