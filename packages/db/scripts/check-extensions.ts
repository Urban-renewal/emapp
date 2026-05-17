import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  const res = await pool.query(
    "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'citext', 'uuid-ossp')",
  );
  process.stdout.write(JSON.stringify(res.rows) + '\n');
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
