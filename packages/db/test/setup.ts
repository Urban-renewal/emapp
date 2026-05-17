import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { pool } from '../src/client';

export async function setupTestDatabase(): Promise<void> {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './migrations' });
}
