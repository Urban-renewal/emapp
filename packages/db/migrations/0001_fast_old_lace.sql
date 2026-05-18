CREATE TABLE IF NOT EXISTS "provider_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"action_type" text NOT NULL,
	"target_table" text,
	"target_record_id" uuid,
	"affected_orgs" uuid[],
	"ip" "inet" NOT NULL,
	"user_agent" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"query_count" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"mfa_secret_encrypted" "bytea" NOT NULL,
	"recovery_codes_hash" jsonb NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_audit_log" ADD CONSTRAINT "provider_audit_log_provider_user_id_provider_users_id_fk" FOREIGN KEY ("provider_user_id") REFERENCES "public"."provider_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_audit_user_time" ON "provider_audit_log" USING btree ("provider_user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_audit_affected_orgs" ON "provider_audit_log" USING gin ("affected_orgs");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_users_email_active" ON "provider_users" USING btree ("email") WHERE disabled_at IS NULL;

CREATE TRIGGER trg_provider_users_updated_at
  BEFORE UPDATE ON provider_users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Database roles for two-tier access
-- app_user: customer-facing (used by withTenant)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
END $$;

-- provider_app_role: provider tier (used by withProvider), bypasses RLS
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'provider_app_role') THEN
    CREATE ROLE provider_app_role;
  END IF;
END $$;

ALTER ROLE provider_app_role BYPASSRLS;

-- app_user has zero access to provider tables (no grants = no access)

-- provider_app_role: full access to provider tables, append-only audit log
GRANT SELECT, INSERT, UPDATE ON provider_users TO provider_app_role;
GRANT SELECT, INSERT ON provider_audit_log TO provider_app_role;