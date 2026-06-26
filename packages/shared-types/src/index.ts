// @emapp/shared-types — FE/BE contract source of truth (Doc 11).
export * from './envelope';
export * from './safe-url';
export * from './auth.schemas';
export * from './project';
export * from './building';
export * from './apartment';
export * from './owner';
export * from './ownership';
// S3c — discovery_records ("renter → discovery-source"). Apartment-attached
// discovery source (occupant), replacing the retired ownerships 'renter'.
export * from './discovery-record';
// S7a — tabu_extractions ("Tabu extraction envelope + lifecycle"). Apartment-
// attached extraction run pointing at a finalized source doc; draft lifecycle.
export * from './tabu-extraction';
// P3a — parcel_setups (parcel-setup envelope + manual path → physical
// skeleton). Project-attached גוש-חלקה setup; STRICT no-PII draft payload.
export * from './parcel-setup';
// P0.C1 — data-subject rights (access export + erasure / right-to-be-forgotten).
export * from './data-subject';
export * from './contractor';
export * from './share';
// X-S2/X-S3 (V13) — generalized party-typed external_share grant.
export * from './external-share';
// D2-DEF-1 / D.46 — Contractor read-tier (share-token scoped, owners-PII
// OFF, aggregate signatures). Tier-isolated read shapes for
// /api/v1/contractor/* under the `emapp-share` JWT audience.
export * from './contractor-read';
export * from './task';
export * from './notification';
export * from './note';
// Internal team messaging — member ↔ member conversations (dashboard "Recent
// conversations" → a real feature). Participation-based authz (RLS + service),
// NOT the IAM matrix; viewer is read-only.
export * from './conversation';
export * from './audit';
export * from './project-assignment';
export * from './member';
// S4b · #8 — capability PRESETS (design §7): a code-defined catalog of named
// role presets (no table). Applying a preset reuses the updateCapabilities path.
export * from './capability-presets';
// P2 Phase 1 — custom roles (org-defined permission groups). Management CRUD +
// assign/revoke wire shapes over the existing IAM data model (roles.org_id).
export * from './role';
// P1-1 — per-org configurable policy seam (the spine). Typed `OrgSettings`
// schema + defaults; `getOrgSettings(tx, orgId)` in @emapp/api parses
// `organizations.settings` jsonb over these. The single source every future
// per-org policy domain reads.
export * from './org-settings';
export * from './document';
export * from './signature-request';
// Autonomous Master Plan, Phase 1 — Approval-Inbox proposal wire shapes
// (pending list + approve/reject). PII-free evidence by contract.
export * from './proposal';
// Autonomous Managing System, wave 1.1 — the PII-FREE `ProjectPerception`
// read-model contract + the `AttentionReason` taxonomy + the
// `attentionReasonToActionKind` (→ `AutonomyActionKind | null`) DECIDE→ACT map.
// The ONE substrate the home KPI / boards / recommenders / cross-party view read.
export * from './project-perception';
// Autonomous Master Plan — PARKED-OUTBOUND ops surface (#509 observability gap).
// Manager-facing read over outbound_ledger + a manager-RESOLVE action for the
// maybe-sent (ambiguous) / never-settled (stale) rows. PII-free by contract.
export * from './parked-outbound';
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
