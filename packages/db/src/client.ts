import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
});

export const db = drizzle(pool);
export type Database = typeof db;

// Provider tier pool — initialized in P1.13
// export const providerPool = ...
// export const providerDb = ...
