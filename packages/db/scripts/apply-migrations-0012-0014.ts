import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pool } from '../src/client';

const MIGRATIONS: Array<{ tag: string; when: number }> = [
  { tag: '0012_project_status_d18', when: 1779034200000 },
  { tag: '0013_hebrew_collation', when: 1779034800000 },
  { tag: '0014_audit_log_to_spec', when: 1779035400000 },
  { tag: '0015_signatures_documents_to_spec', when: 1779036000000 },
];

async function main() {
  const client = await pool.connect();
  try {
    for (const m of MIGRATIONS) {
      const sql = await readFile(join(__dirname, '..', 'migrations', `${m.tag}.sql`), 'utf8');
      await client.query(sql);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [m.tag, m.when],
      );
      process.stdout.write(`applied + tracked: ${m.tag}\n`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Apply failed: ${String(err)}\n`);
  process.exit(1);
});
