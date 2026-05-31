-- 0042 (D.54): add the view_owner_pii read-fidelity capability to the
-- per-agent capability set.
--
-- D.54 makes owner-PII read fidelity (masked | unmasked) a manager-toggled
-- per-person capability. Default = masked (least-privilege); managers grant
-- `view_owner_pii=true` to field staff who must verify national_id / phone.
--
-- Two changes, both safe:
--   1. Update the column DEFAULT to include view_owner_pii:false, so NEW
--      memberships carry the 7-key set.
--   2. Backfill EXISTING rows that lack the key (every row created under
--      migration 0041's 6-key default) with view_owner_pii:false — i.e. the
--      masked-by-default posture, NO escalation for anyone existing.
--
-- jsonb_set with create_missing=true only adds the key when absent, so this is
-- idempotent and never overwrites a manager's explicit grant.
ALTER TABLE memberships
  ALTER COLUMN capabilities SET DEFAULT
    '{"edit_project_data": false, "manage_documents": false, "manage_signatures": false, "manage_tasks": false, "run_imports": false, "view_owners": true, "view_owner_pii": false}'::jsonb;
--> statement-breakpoint
UPDATE memberships
   SET capabilities = jsonb_set(capabilities, '{view_owner_pii}', 'false'::jsonb, true)
 WHERE NOT (capabilities ? 'view_owner_pii');
