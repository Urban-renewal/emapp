/**
 * SAMPLE_* convention — Doc 05 §10 + Doc 11 §2 (closes §v9-P0-1).
 *
 * Every entity exports `SAMPLE_<ENTITY>S` as a Zod-validated array.
 * These fixtures are the offline-development surface (MSW handlers
 * return them) AND the deterministic test data set for adversarial
 * specs.
 *
 * CI gate: `apps/web/src/mocks/samples/samples.spec.ts` Schema-parses
 * every export — drift = red build.
 */
export * from './users';
export * from './projects';
export * from './buildings';
export * from './apartments';
export * from './owners';
export * from './ownerships';
export * from './documents';
export * from './imports';
export * from './signature-requests';
export * from './signature-pulse';
