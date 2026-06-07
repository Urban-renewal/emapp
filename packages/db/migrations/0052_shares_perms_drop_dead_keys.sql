-- 0052 — A3 (L4): strip DEAD permission keys from shares.permissions.
-- (renumbered 0051→0052: Feature A PR #286 holds 0051; this migration must
--  apply AFTER it. Both are Gate-6 held for the owner's end-of-run review.)
--
-- The contractor read-path (contractor-read.service / contractor-auth.guard)
-- only ever consulted overview / documents{download} / signatures. The keys
-- `tenants` (incl. its PII `fields.national_id` footgun), `notes`, `team`, and
-- `documents.actions.upload` granted NOTHING — they were dead. The schema
-- (_share-permissions.ts + shared-types) was narrowed to drop them; this
-- migration brings persisted JSONB into line so a freshly-read row re-parses
-- cleanly against the new .strict() schema (which now REJECTS those keys).
--
-- Root-cause cleanup, not a UI-only hide: an existing row carrying
-- `{tenants,...}` / `{...documents:{actions:{upload}}}` is rewritten to the new
-- shape; a row already in the new shape is untouched (the `-` / `#-` operators
-- are no-ops when the path is absent). Idempotent + re-runnable.
--
-- `-` deletes a top-level key; `#-` deletes a nested path. Applied to ALL rows
-- (active and revoked) so historical/revoked shares also normalize.
UPDATE shares
SET permissions =
      (permissions - 'tenants' - 'notes' - 'team') #- '{documents,actions,upload}'
WHERE permissions ? 'tenants'
   OR permissions ? 'notes'
   OR permissions ? 'team'
   OR permissions #> '{documents,actions}' ? 'upload';
