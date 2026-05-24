/**
 * v8.5 thin re-export — the implementation was lifted to @emapp/db
 * so both the worker terminal-state path AND the API cancel() path
 * can invoke it. Pre-lift: only the worker could purge, which meant
 * cancel-via-API leaked PII bytes forever (v8.5 SOLID #4 +
 * Security cross-confirmed P0).
 *
 * Existing imports `from '../handlers/purge-import-bytes'` keep
 * working; the public surface is unchanged.
 */
export { purgeImportBytes, type PurgeImportBytesOpts, type PurgeLogger } from '@emapp/db';
