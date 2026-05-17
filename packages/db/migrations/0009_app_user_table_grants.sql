-- Grant app_user access to all tables created after the initial grant in 0001.
-- Subsequent migrations (0002, 0003, 0007) added new tables without re-running GRANT.
-- PostgreSQL GRANT ON ALL TABLES is not retroactive for future tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Re-revoke provider tables — app_user must never access them
REVOKE ALL ON TABLE provider_users FROM app_user;
REVOKE ALL ON TABLE provider_audit_log FROM app_user;

-- audit_log: app_user gets INSERT + SELECT (already granted in 0003, but re-assert)
GRANT INSERT, SELECT ON TABLE audit_log TO app_user;

-- Set default privileges so future tables in schema public auto-grant to app_user
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
