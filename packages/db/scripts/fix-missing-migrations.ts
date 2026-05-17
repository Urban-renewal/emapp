import { pool } from '../src/client';

async function main() {
  const client = await pool.connect();
  try {
    // Apply 0006: make provider_audit_log.ip nullable
    await client.query(`ALTER TABLE "provider_audit_log" ALTER COLUMN "ip" DROP NOT NULL`);
    process.stdout.write('0006: ip column made nullable\n');

    // Apply 0007: create cache_kv table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "cache_kv" (
        "key" text PRIMARY KEY NOT NULL,
        "value" jsonb NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS "idx_cache_kv_expires" ON "cache_kv" USING btree ("expires_at")`,
    );
    process.stdout.write('0007: cache_kv table created\n');

    // Grant cache_kv access to app_user (0009 runs GRANT ON ALL TABLES which won't catch it if it's new)
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cache_kv TO app_user`);
    process.stdout.write('0007: cache_kv granted to app_user\n');

    // Record 0006 and 0007 in drizzle.__drizzle_migrations so migrate won't re-run them
    await client.query(`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES
        ('0006_cool_roulette', 1779031300000),
        ('0007_warm_owl', 1779031400000)
      ON CONFLICT DO NOTHING
    `);
    process.stdout.write('Tracking entries added\n');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fix failed: ${String(err)}\n`);
  process.exit(1);
});
