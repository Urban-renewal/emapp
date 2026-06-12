-- Local dev bootstrap — mirrors what the Neon project has pre-provisioned.
-- Runs once on first `docker compose up` (fresh volume).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
-- The app connects as a BYPASSRLS-capable owner role for migrations and uses
-- SET LOCAL ROLE app_user for tenant queries (withTenant) — mirror Neon:
CREATE ROLE app_user NOLOGIN;
