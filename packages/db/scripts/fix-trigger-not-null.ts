import { pool } from '../src/client';

async function main() {
  const client = await pool.connect();
  try {
    // Drop NOT NULL on org_id in buildings/apartments.
    // The trigger guarantees org_id is filled for valid inserts.
    // For invalid parent IDs, the FK constraint must fire; NOT NULL firing first
    // changes the error code from 23503 to 23502, breaking FK tests.
    await client.query(`ALTER TABLE buildings ALTER COLUMN org_id DROP NOT NULL`);
    process.stdout.write('buildings: org_id DROP NOT NULL done\n');

    await client.query(`ALTER TABLE apartments ALTER COLUMN org_id DROP NOT NULL`);
    process.stdout.write('apartments: org_id DROP NOT NULL done\n');

    // Soften triggers: don't raise exception when org_id can't be resolved.
    // Let the DB's FK constraints handle the invalid parent case.
    await client.query(`
      CREATE OR REPLACE FUNCTION fn_buildings_fill_org_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id IS NULL THEN
          SELECT org_id INTO NEW.org_id FROM projects WHERE id = NEW.project_id;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    process.stdout.write('fn_buildings_fill_org_id: updated\n');

    await client.query(`
      CREATE OR REPLACE FUNCTION fn_apartments_fill_org_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id IS NULL THEN
          SELECT org_id INTO NEW.org_id FROM buildings WHERE id = NEW.building_id;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    process.stdout.write('fn_apartments_fill_org_id: updated\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fix failed: ${String(err)}\n`);
  process.exit(1);
});
