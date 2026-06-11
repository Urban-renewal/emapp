import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { projectTypeEnum, projectStatusEnum, apartmentStatusEnum } from './_enums';
import { bytea, citext } from './_types';
import { organizations, users } from './tenancy';

/**
 * Local structural mirror of `@emapp/shared-types` `SignatureMilestone`.
 * `@emapp/db` does NOT depend on `@emapp/shared-types` (and shared-types must
 * stay import-free to avoid cycles), so the canonical Zod schema there is the
 * source of truth and this is just the storage-layer type for the jsonb column.
 * Owner-approved Gate-6 (Option A): ordered intermediate signature targets.
 */
export interface SignatureMilestone {
  pct: number;
  label?: string;
}

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    type: projectTypeEnum('type').notNull(),
    status: projectStatusEnum('status').notNull().default('planning'),
    description: text('description'),
    targetSignaturePct: numeric('target_signature_pct', { precision: 5, scale: 2 }),
    // Owner-approved Gate-6 (Option A, migration 0053) — ordered intermediate
    // signature targets (staged overlay). Nullable jsonb, no default; shape is
    // validated at the Zod boundary (SignatureMilestonesSchema in shared-types).
    signatureMilestones: jsonb('signature_milestones').$type<SignatureMilestone[]>(),
    // ── P3 project create-form enrichment (migration 0062) ──────────────────
    // All additive + NULLABLE → zero breakage to existing rows/create flow.
    // 1. developer / יזם — the entity executing the project (often distinct
    //    from the managing org). Free-text name + optional company-id (ח.פ.).
    developerName: text('developer_name'),
    developerCompanyId: text('developer_company_id'),
    // 2. unit / תמורה ratio — owner-compensation basics, modelled generically
    //    (not over-fit): existing vs planned units (the expansion) + extra area.
    existingUnits: integer('existing_units'),
    plannedUnits: integer('planned_units'),
    extraAreaSqm: numeric('extra_area_sqm', { precision: 10, scale: 2 }),
    // 3. relocation / פינוי — demolish-rebuild residents vacate. Closed set
    //    (none|rent_comp|alt_housing) enforced by a DB CHECK (0062) + the Zod
    //    enum at the API edge; NULL = unspecified. Free-text notes alongside.
    relocationType: text('relocation_type'),
    relocationNotes: text('relocation_notes'),
    // 4. future-track label — paired with the additive `project_type` 'other'
    //    enum value (0062). Human name of a renewal track not yet enumerated.
    typeLabel: text('type_label'),
    // 5. parcel provenance / גוש-חלקה — the project site's lead land-registration
    //    identity. Distinct from the per-building block/parcel columns (a
    //    project can span many buildings/parcels; these are the headline ones).
    block: text('block'),
    parcel: text('parcel'),
    subparcel: text('subparcel'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    orgStatusIdx: index('idx_projects_org_status')
      .on(table.orgId, table.status)
      .where(sql`archived_at IS NULL`),
    orgTypeIdx: index('idx_projects_org_type').on(table.orgId, table.type),
  }),
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export const buildings = pgTable(
  'buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    city: text('city').notNull(),
    block: text('block'),
    parcel: text('parcel'),
    subparcel: text('subparcel'),
    aptCount: integer('apt_count').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    projectIdx: index('idx_buildings_project')
      .on(table.projectId)
      .where(sql`archived_at IS NULL`),
  }),
);

export type Building = typeof buildings.$inferSelect;
export type NewBuilding = typeof buildings.$inferInsert;

export const apartments = pgTable(
  'apartments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buildingId: uuid('building_id')
      .notNull()
      .references(() => buildings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    floor: integer('floor'),
    sizeSqm: numeric('size_sqm', { precision: 7, scale: 2 }),
    rooms: numeric('rooms', { precision: 3, scale: 1 }),
    status: apartmentStatusEnum('status').notNull().default('pending'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
    notes: text('notes'),
    // D.39 — partner's design has non-residential units inside buildings
    // (shop / office / mixed). Closed enum at the Zod boundary; existing
    // rows backfill to 'apt' (pre-D.39 implicit residential).
    unitType: text('unit_type').notNull().default('apt'),
    // D.39 — registered area_sqm from the parcel record, distinct from
    // size_sqm (the self-declared measurement); they can legally differ.
    areaSqm: numeric('area_sqm', { precision: 10, scale: 2 }),
    // D.39 — entrance label this apartment belongs to (mirrors
    // building_sections.entrance for sectioned buildings).
    entrance: text('entrance'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    uniqueNumberPerBuilding: uniqueIndex('apartments_building_number_active')
      .on(table.buildingId, table.number)
      .where(sql`archived_at IS NULL`),
    buildingIdx: index('idx_apartments_building')
      .on(table.buildingId)
      .where(sql`archived_at IS NULL`),
    statusIdx: index('idx_apartments_status')
      .on(table.status)
      .where(sql`archived_at IS NULL`),
  }),
);

export type Apartment = typeof apartments.$inferSelect;
export type NewApartment = typeof apartments.$inferInsert;

// D.39 / V11 B.S1 — sectioned buildings (entrance × kind × floors × unit_count
// + optional own parcel). RLS via parent (Template B per D.24 + 0011 revert):
// section → building → project → org_id GUC. Enum (kind) checked at Zod
// boundary, not DB CHECK — additive-only canary; belt-and-suspenders CHECK
// can be added in a follow-up if a later audit requires it.
export const buildingSections = pgTable(
  'building_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buildingId: uuid('building_id')
      .notNull()
      .references(() => buildings.id, { onDelete: 'cascade' }),
    entrance: text('entrance'),
    // Closed enum at Zod boundary: residential | office | retail | mixed
    kind: text('kind').notNull(),
    floors: integer('floors'),
    unitCount: integer('unit_count'),
    gush: text('gush'),
    helka: text('helka'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    buildingIdx: index('idx_building_sections_building')
      .on(table.buildingId)
      .where(sql`archived_at IS NULL`),
  }),
);

export type BuildingSection = typeof buildingSections.$inferSelect;
export type NewBuildingSection = typeof buildingSections.$inferInsert;

// owners and ownerships — added in P1.5 (depends on pgcrypto from P1.10)

export const owners = pgTable(
  'owners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // v8 §v8-S3: `name` moved to pgcrypto-encrypted bytea + a hashed
    // form for future exact-match lookup. Cleartext column dropped in
    // migration 0033. Every read goes through decryptOwnerName() /
    // every write through encryptOwnerName() (helpers in
    // packages/db/src/helpers/owners.ts).
    // S3a (migration 0064) — nullable so an owner SHELL (Tabu/parcel
    // skeleton: no name, no national_id; a field worker enriches later)
    // can be created. A live, enriched owner has this set via
    // encryptOwnerPii/encryptOwnerName on the create/import path.
    nameEncrypted: bytea('name_encrypted'),
    // P0.C1 — nullable so the erasure (crypto-shred) path can NULL the HMAC
    // lookup hash: an erased owner has no name/national_id to hash anymore, so
    // they can no longer be found by HMAC. A LIVE owner always has these set
    // (enforced by encryptOwnerPii on every create/import). Migration 0057
    // dropped the NOT NULL.
    nameHash: bytea('name_hash'),
    email: citext('email'),
    // S3a (migration 0064) — nullable for owner SHELLS (see name_encrypted
    // above). When a national_id IS present the per-org unique index
    // (owners_org_natid_unique_active) still enforces uniqueness; NULLs are
    // distinct so multiple shells coexist.
    nationalIdEncrypted: bytea('national_id_encrypted'),
    nationalIdHash: text('national_id_hash'),
    phoneEncrypted: bytea('phone_encrypted'),
    phoneHash: text('phone_hash'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // P0.C1 — data-subject ERASURE (right-to-be-forgotten) tombstone. A
    // non-null `erasedAt` means this owner's PII has been crypto-shredded
    // (name/national_id/phone ciphertext overwritten with an irreversible
    // tombstone, HMAC hashes NULLed). DISTINCT from `archivedAt` (a reversible
    // soft-delete that keeps PII recoverable). An erased owner is excluded from
    // every operational list/scope and is un-revealable. `erasedBy` is the
    // acting user (SET NULL on user delete; the durable forensic copy lives in
    // erasure_log). See migration 0057 + docs/DECISION-erasure-vs-legal-retention.md.
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    erasedBy: uuid('erased_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    orgNationalIdHashIdx: index('idx_owners_org_natid_hash').on(table.orgId, table.nationalIdHash),
    orgPhoneHashIdx: index('idx_owners_org_phone_hash')
      .on(table.orgId, table.phoneHash)
      .where(sql`phone_hash IS NOT NULL`),
    uniqueNationalIdPerOrg: uniqueIndex('owners_org_natid_unique_active')
      .on(table.orgId, table.nationalIdHash)
      .where(sql`archived_at IS NULL`),
    // P0.C1 — supports the common operational query that excludes erased owners.
    orgNotErasedIdx: index('idx_owners_org_not_erased')
      .on(table.orgId)
      .where(sql`erased_at IS NULL`),
    // v8 §v8-S3 — supports future exact-match owner lookup by name.
    orgNameHashIdx: index('idx_owners_org_name_hash')
      .on(table.orgId, table.nameHash)
      .where(sql`archived_at IS NULL`),
  }),
);

export type Owner = typeof owners.$inferSelect;
export type NewOwner = typeof owners.$inferInsert;

export const ownerships = pgTable(
  'ownerships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apartmentId: uuid('apartment_id')
      .notNull()
      .references(() => apartments.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    ownershipPct: numeric('ownership_pct', { precision: 5, scale: 2 }).notNull(),
    // S3b — ownership share AS FRACTION (exact Tabu fractions, sum = 1).
    // The canonical EXACT share is the rational `share_numerator /
    // share_denominator` (e.g. 1/3, 17/240); `ownershipPct` above is now a
    // derived 2-decimal compat value (round(num/den*100, 2)) kept in sync on
    // every write. The sum trigger (migration 0065) validates the EXACT
    // fraction sum = 1 per apartment over relationship='owner' rows via
    // integer cross-multiplication — no float drift (33.33×3 ≠ 99.99 issue).
    // DB DEFAULTs (0 / 10000) let a pct-only INSERT omit them; positive
    // denominator enforced by the ownerships_share_den_positive CHECK.
    shareNumerator: bigint('share_numerator', { mode: 'number' }).notNull().default(0),
    shareDenominator: bigint('share_denominator', { mode: 'number' }).notNull().default(10000),
    role: text('role'),
    // Feature A (P2 / D.25 sum-trigger change) — owner vs renter. A renter
    // does NOT sign and is EXCLUDED from the 100% ownership sum (the D.25
    // constraint trigger sums `relationship = 'owner'` rows only). Renters
    // store ownership_pct = 0 (column stays NOT NULL — option (a)). Closed
    // set enforced by a DB CHECK (('owner','renter')) AND the Zod enum at
    // the API edge. DISTINCT from the pre-existing `role` text column above
    // (values like 'primary') — do NOT overload `role`.
    relationship: text('relationship').notNull().default('owner'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueActive: uniqueIndex('ownerships_apt_owner_active')
      .on(table.apartmentId, table.ownerId)
      .where(sql`ended_at IS NULL`),
    apartmentActiveIdx: index('idx_ownerships_apartment_active')
      .on(table.apartmentId)
      .where(sql`ended_at IS NULL`),
    ownerActiveIdx: index('idx_ownerships_owner_active')
      .on(table.ownerId)
      .where(sql`ended_at IS NULL`),
  }),
);

export type Ownership = typeof ownerships.$inferSelect;
export type NewOwnership = typeof ownerships.$inferInsert;

// S3c — discovery_records (migration 0066). "renter → discovery-source": an
// occupant is NOT an owner/signer — it is a DISCOVERY SOURCE attached to an
// APARTMENT (a field worker spoke to whoever lives there to learn who the owner
// is). Retires the overloaded ownerships.relationship='renter'. RLS via parent
// (Template B, like building_sections): apartment → building → project → org.
// `status` is a closed enum at the Zod boundary AND a DB CHECK; recording_ref /
// transcript are §6 DEFERRED slots (audio + transcript), present but never
// populated this slice (the create/update DTOs omit them).
export const discoveryRecords = pgTable(
  'discovery_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    apartmentId: uuid('apartment_id')
      .notNull()
      .references(() => apartments.id, { onDelete: 'cascade' }),
    // Closed enum (DB CHECK + Zod): not_visited | no_answer | spoke_to_occupant
    //   | owner_identified | refused.
    status: text('status').notNull().default('not_visited'),
    notes: text('notes'),
    // §6 DEFERRED slots — never populated this slice.
    recordingRef: text('recording_ref'),
    transcript: text('transcript'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    orgIdx: index('idx_discovery_records_org').on(table.orgId),
    apartmentIdx: index('idx_discovery_records_apartment')
      .on(table.apartmentId)
      .where(sql`archived_at IS NULL`),
  }),
);

export type DiscoveryRecord = typeof discoveryRecords.$inferSelect;
export type NewDiscoveryRecord = typeof discoveryRecords.$inferInsert;
