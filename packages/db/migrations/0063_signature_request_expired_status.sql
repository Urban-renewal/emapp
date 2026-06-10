-- 0063 — signature_requests: add 'expired' status (Slice 1, signature correctness).
--
-- A pending signing link has a hard 7-day expiry (the JWT exp + the row's
-- expires_at). Before this migration the status machine had no terminal
-- 'expired' state: an expired pending row stayed `status='pending'` forever,
-- which (a) misrepresented the request's real state in the manager/portal
-- views and (b) — combined with the create() dedup guard keying on
-- status='pending' — blocked the manager from issuing a fresh request for the
-- same (document, owner) even though the old link was dead.
--
-- This migration widens the status CHECK to admit 'expired' and backfills any
-- already-lapsed pending rows. The matching dedup fix (the create/bulk
-- predicates now also require expires_at > now()) lands in the service layer.
--
-- CHECK == wire-enum invariant: SignatureRequestStatusEnum in
-- @emapp/shared-types is updated to ['pending','signed','cancelled','expired']
-- in the same slice.

-- (a) drop the old constraint if present (idempotent).
ALTER TABLE signature_requests
  DROP CONSTRAINT IF EXISTS signature_requests_status_valid;

-- (b) re-add it with the widened value set.
ALTER TABLE signature_requests
  ADD CONSTRAINT signature_requests_status_valid
  CHECK (status IN ('pending','signed','cancelled','expired'));

-- (c) backfill: any pending request whose deadline has already passed is, by
-- definition, expired. Signed/cancelled rows are forensic and untouched.
UPDATE signature_requests
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at <= now();
