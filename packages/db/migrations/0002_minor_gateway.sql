CREATE TABLE IF NOT EXISTS "apartments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"building_id" uuid NOT NULL,
	"number" text NOT NULL,
	"floor" integer,
	"size_sqm" numeric(7, 2),
	"rooms" numeric(3, 1),
	"status" "apartment_status" DEFAULT 'pending' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_contact_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"address" text NOT NULL,
	"city" text NOT NULL,
	"block" text,
	"parcel" text,
	"subparcel" text,
	"apt_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" "citext",
	"national_id_encrypted" "bytea" NOT NULL,
	"national_id_hash" text NOT NULL,
	"phone_encrypted" "bytea",
	"phone_hash" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apartment_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"ownership_pct" numeric(5, 2) NOT NULL,
	"role" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "project_type" NOT NULL,
	"status" "project_status" DEFAULT 'planning' NOT NULL,
	"description" text,
	"target_signature_pct" numeric(5, 2),
	"started_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "apartments" ADD CONSTRAINT "apartments_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buildings" ADD CONSTRAINT "buildings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "owners" ADD CONSTRAINT "owners_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_apartment_id_apartments_id_fk" FOREIGN KEY ("apartment_id") REFERENCES "public"."apartments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apartments_building_number_active" ON "apartments" USING btree ("building_id","number") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apartments_building" ON "apartments" USING btree ("building_id") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apartments_status" ON "apartments" USING btree ("status") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_buildings_project" ON "buildings" USING btree ("project_id") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owners_org_natid_hash" ON "owners" USING btree ("org_id","national_id_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owners_org_phone_hash" ON "owners" USING btree ("org_id","phone_hash") WHERE phone_hash IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "owners_org_natid_unique_active" ON "owners" USING btree ("org_id","national_id_hash") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ownerships_apt_owner_active" ON "ownerships" USING btree ("apartment_id","owner_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ownerships_apartment_active" ON "ownerships" USING btree ("apartment_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ownerships_owner_active" ON "ownerships" USING btree ("owner_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_org_status" ON "projects" USING btree ("org_id","status") WHERE archived_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_org_type" ON "projects" USING btree ("org_id","type");

-- pgcrypto required for PII encryption (owners.national_id_encrypted, phone_encrypted)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- updated_at triggers for projects, buildings, apartments, owners, ownerships
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_buildings_updated_at
  BEFORE UPDATE ON buildings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_apartments_updated_at
  BEFORE UPDATE ON apartments
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_owners_updated_at
  BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER trg_ownerships_updated_at
  BEFORE UPDATE ON ownerships
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Update status_changed_at whenever apartment status changes
CREATE OR REPLACE FUNCTION trigger_apartment_status_changed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apartments_status_changed
  BEFORE UPDATE ON apartments
  FOR EACH ROW EXECUTE FUNCTION trigger_apartment_status_changed();

-- Keep buildings.apt_count in sync with active apartments
CREATE OR REPLACE FUNCTION trigger_building_apt_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.archived_at IS NULL THEN
    UPDATE buildings SET apt_count = apt_count + 1 WHERE id = NEW.building_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
      UPDATE buildings SET apt_count = apt_count - 1 WHERE id = NEW.building_id;
    ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
      UPDATE buildings SET apt_count = apt_count + 1 WHERE id = NEW.building_id;
    END IF;
  ELSIF TG_OP = 'DELETE' AND OLD.archived_at IS NULL THEN
    UPDATE buildings SET apt_count = apt_count - 1 WHERE id = OLD.building_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apartments_count_maintenance
  AFTER INSERT OR UPDATE OR DELETE ON apartments
  FOR EACH ROW EXECUTE FUNCTION trigger_building_apt_count();

-- Enforce SUM(ownership_pct) = 100 per apartment (DEFERRABLE for multi-row updates)
CREATE OR REPLACE FUNCTION trigger_check_ownership_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_apartment_id uuid;
  v_total numeric(7,2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_apartment_id := OLD.apartment_id;
  ELSE
    v_apartment_id := NEW.apartment_id;
  END IF;

  SELECT COALESCE(SUM(ownership_pct), 0) INTO v_total
  FROM ownerships
  WHERE apartment_id = v_apartment_id AND ended_at IS NULL;

  IF v_total > 0 AND v_total <> 100 THEN
    RAISE EXCEPTION 'Sum of ownership percentages must equal 100 for apartment %, got %',
      v_apartment_id, v_total;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ownerships_sum_check
  AFTER INSERT OR UPDATE OR DELETE ON ownerships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trigger_check_ownership_sum();