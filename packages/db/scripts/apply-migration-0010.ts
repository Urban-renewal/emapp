import { pool } from '../src/client';

async function main() {
  const client = await pool.connect();
  try {
    // Apply 0010 directly — bypasses drizzle migrator's concurrent-worker race condition.
    // All DDL is idempotent (IF NOT EXISTS / IF EXISTS guards) so re-running is safe.

    // ── buildings: org_id ──────────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE buildings
        ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE RESTRICT
    `);
    await client.query(`
      UPDATE buildings
      SET org_id = (SELECT org_id FROM projects WHERE id = buildings.project_id)
      WHERE org_id IS NULL
    `);
    await client.query(`ALTER TABLE buildings ALTER COLUMN org_id SET NOT NULL`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_buildings_org ON buildings(org_id)
        WHERE archived_at IS NULL
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION fn_buildings_fill_org_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id IS NULL THEN
          SELECT org_id INTO NEW.org_id FROM projects WHERE id = NEW.project_id;
          IF NEW.org_id IS NULL THEN
            RAISE EXCEPTION 'buildings: cannot resolve org_id for project_id %', NEW.project_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_buildings_fill_org_id ON buildings`);
    await client.query(`
      CREATE TRIGGER trg_buildings_fill_org_id
        BEFORE INSERT ON buildings
        FOR EACH ROW EXECUTE FUNCTION fn_buildings_fill_org_id()
    `);
    await client.query(`DROP POLICY IF EXISTS tenant_isolation ON buildings`);
    await client.query(`
      CREATE POLICY tenant_isolation ON buildings
        USING (org_id = current_setting('app.organization_id', true)::uuid)
        WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid)
    `);
    process.stdout.write('0010: buildings org_id done\n');

    // ── apartments: org_id ────────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE apartments
        ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE RESTRICT
    `);
    await client.query(`
      UPDATE apartments
      SET org_id = (
        SELECT p.org_id
        FROM projects p
        JOIN buildings b ON b.project_id = p.id
        WHERE b.id = apartments.building_id
      )
      WHERE org_id IS NULL
    `);
    await client.query(`ALTER TABLE apartments ALTER COLUMN org_id SET NOT NULL`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_apartments_org ON apartments(org_id)
        WHERE archived_at IS NULL
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION fn_apartments_fill_org_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id IS NULL THEN
          SELECT org_id INTO NEW.org_id FROM buildings WHERE id = NEW.building_id;
          IF NEW.org_id IS NULL THEN
            RAISE EXCEPTION 'apartments: cannot resolve org_id for building_id %', NEW.building_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_apartments_fill_org_id ON apartments`);
    await client.query(`
      CREATE TRIGGER trg_apartments_fill_org_id
        BEFORE INSERT ON apartments
        FOR EACH ROW EXECUTE FUNCTION fn_apartments_fill_org_id()
    `);
    await client.query(`DROP POLICY IF EXISTS tenant_isolation ON apartments`);
    await client.query(`
      CREATE POLICY tenant_isolation ON apartments
        USING (org_id = current_setting('app.organization_id', true)::uuid)
        WITH CHECK (org_id = current_setting('app.organization_id', true)::uuid)
    `);
    process.stdout.write('0010: apartments org_id done\n');

    // ── indexes ───────────────────────────────────────────────────────────────
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by)`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notes_created_by ON notes(created_by)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_contractors_created_by ON contractors(created_by)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_task_assignees_assigned_by ON task_assignees(assigned_by)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_project_assignments_assigned_by ON project_assignments(assigned_by)`,
    );
    process.stdout.write('0010: indexes done\n');

    // ── slug CHECK constraint ─────────────────────────────────────────────────
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'organizations_slug_format'
            AND conrelid = 'organizations'::regclass
        ) THEN
          ALTER TABLE organizations
            ADD CONSTRAINT organizations_slug_format
            CHECK (slug ~ '^[a-z][a-z0-9-]*[a-z0-9]$');
        END IF;
      END;
      $$
    `);
    process.stdout.write('0010: slug CHECK constraint done\n');

    // ── record in drizzle tracking table ──────────────────────────────────────
    await client.query(`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ('0010_performance_and_security', 1779033000000)
      ON CONFLICT DO NOTHING
    `);
    process.stdout.write('0010: tracking entry added\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration 0010 failed: ${String(err)}\n`);
  process.exit(1);
});
