import { pool } from '../src/client';

async function main() {
  const client = await pool.connect();
  try {
    // Triggers for auto-filling org_id violated SOLID and security principles:
    // - They fire before FK constraints, masking FK violations with P0001 errors
    // - They add hidden implicit behavior; application code (withTenant) already holds orgId
    // Application code is responsible for always providing org_id explicitly.
    await client.query(`DROP TRIGGER IF EXISTS trg_buildings_fill_org_id ON buildings`);
    await client.query(`DROP TRIGGER IF EXISTS trg_apartments_fill_org_id ON apartments`);
    await client.query(`DROP FUNCTION IF EXISTS fn_buildings_fill_org_id()`);
    await client.query(`DROP FUNCTION IF EXISTS fn_apartments_fill_org_id()`);
    process.stdout.write('triggers and functions dropped\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed: ${String(err)}\n`);
  process.exit(1);
});
