import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { db, pool } from '../src/client';

async function main() {
  await migrate(db, { migrationsFolder: './migrations' });
  process.stdout.write('Migrations applied successfully\n');
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration failed: ${String(err)}\n`);
  process.exit(1);
});
