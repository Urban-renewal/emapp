import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

type DrizzleInstance = ReturnType<typeof drizzle>;

let _db: DrizzleInstance | undefined;

export function getDb(): DrizzleInstance {
  if (!_db) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required — add it to Infisical and run via infisical run');
    _db = drizzle(postgres(url, { max: 10 }));
  }
  return _db;
}
