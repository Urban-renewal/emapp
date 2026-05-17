import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pool } from '../src/client';

async function main() {
  const sql = await readFile(
    join(__dirname, '..', 'migrations', '0011_revert_buildings_apartments_to_spec.sql'),
    'utf8',
  );
  const client = await pool.connect();
  try {
    await client.query(sql);
    process.stdout.write('0011: applied (buildings/apartments reverted to Template B)\n');
    await client.query(`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ('0011_revert_buildings_apartments_to_spec', 1779033600000)
      ON CONFLICT DO NOTHING
    `);
    process.stdout.write('0011: tracking entry added\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration 0011 failed: ${String(err)}\n`);
  process.exit(1);
});
