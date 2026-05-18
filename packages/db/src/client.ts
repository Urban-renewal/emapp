import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from './env';
import * as schema from './schema/index';

const appPoolConfig = {
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
};

export const pool = new Pool(appPoolConfig);
export const db = drizzle(pool, { schema });
export type Database = NodePgDatabase<typeof schema>;

pool.on('error', (err: Error) => {
  process.stderr.write(`[appPool] idle client error: ${err.message}\n`);
});

const providerPoolConfig = {
  connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 60000,
};

export const providerPool = new Pool(providerPoolConfig);
export const providerDb = drizzle(providerPool, { schema });
export type ProviderDatabase = NodePgDatabase<typeof schema>;

providerPool.on('error', (err: Error) => {
  process.stderr.write(`[providerPool] idle client error: ${err.message}\n`);
});
