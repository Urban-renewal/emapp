// @emapp/shared-types — FE/BE contract source of truth (Doc 11).
export * from './envelope';
export * from './safe-url';
export * from './auth.schemas';
export * from './project';
export * from './building';
export * from './apartment';
export * from './owner';
export * from './ownership';
export * from './contractor';
export * from './share';
// D2-DEF-1 / D.46 — Contractor read-tier (share-token scoped, owners-PII
// OFF, aggregate signatures). Tier-isolated read shapes for
// /api/v1/contractor/* under the `emapp-share` JWT audience.
export * from './contractor-read';
export * from './task';
export * from './notification';
export * from './note';
export * from './audit';
export * from './project-assignment';
export * from './member';
export * from './document';
export * from './signature-request';
export * from './import';
// D.37 — Phase 6.5 Provider Admin BE (read-only). Tier-isolated wire
// shapes for /api/v1/provider/* endpoints. NEVER share fields with the
// org-tier audit / member schemas: provider tier is BYPASSRLS + masked-
// always, and conflating the two shapes risks a future change leaking
// org-cleartext through a "shared" type.
export * from './provider';
// V11 B.S4 — Tenant Portal own-data view (D.40). Tier-isolated wire
// shapes for /api/v1/portal/* under the `emapp-tenant` JWT audience.
// All endpoints scoped to the authenticated tenant's own owner.id.
export * from './portal';
