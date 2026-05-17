-- P1.11 fix: Grant app_user to the database owner so SET ROLE app_user works
-- in withTenant. The owner role (neondb_owner) has BYPASSRLS, so all queries
-- as owner ignore RLS. withTenant must SET ROLE app_user to activate RLS policies.
DO $$ BEGIN
  EXECUTE 'GRANT app_user TO ' || quote_ident(current_user);
END $$;

-- Also grant app_user to provider_app_role so it can SET ROLE app_user if needed
-- (Not needed in most cases, but ensures role graph is complete)
DO $$ BEGIN
  EXECUTE 'GRANT app_user TO provider_app_role';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
