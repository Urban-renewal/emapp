// DB package public API
// Direct db/pool access is internal only — all external reads go through withTenant / withProvider (P1.13)
export { pool, db, type Database } from './client.js';
export { env } from './env.js';
export * from './schema/index.js';
export { sql } from 'drizzle-orm';
