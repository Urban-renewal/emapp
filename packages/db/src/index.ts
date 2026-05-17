// DB package public API
// Direct db/pool access is internal only — all external reads go through withTenant / withProvider (P1.13)
export { pool, db, type Database } from './client';
export { env } from './env';
export * from './schema/index';
export { sql } from 'drizzle-orm';
