-- 0029: UNIQUE (project_id, address) on buildings (audit-pass v3 A1 fix)
--
-- Audit-pass v3 finding A1 (MEDIUM). The worker's findOrCreateBuilding
-- did SELECT-then-INSERT on (project_id, address) under withTenant.
-- Two concurrent imports for the same org+project+address would both
-- pass the SELECT (empty), then both INSERT. WITHOUT a unique index,
-- both succeed → SILENT DUPLICATE buildings in the DB. Subsequent
-- imports would non-deterministically bind to either copy.
--
-- The other two find-or-create paths (apartments, owners) are already
-- protected by partial unique indexes from migration 0002. Buildings
-- was the gap — closed here.
--
-- Partial — only active buildings participate. An archived building
-- with the same address can coexist (intentional: soft-delete should
-- never block a fresh create of the "same" entity).
--
-- Idempotent — CREATE UNIQUE INDEX IF NOT EXISTS.
--
-- Forward-only; the post-S6 happy-path tests CONFIRM no duplicate
-- buildings exist yet (test 1 in persistence.s6.spec.ts counts
-- buildings created and asserts =1). If duplicates DID exist pre-
-- merge, this migration would fail at index build — that's the right
-- safety net.

CREATE UNIQUE INDEX IF NOT EXISTS buildings_project_address_active
  ON buildings (project_id, address)
  WHERE archived_at IS NULL;
