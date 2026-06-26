import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

import { apartmentStateKindEnum, apartmentStateStatusEnum } from './_enums';
import { apartments } from './projects';
import { organizations, users } from './tenancy';

/**
 * Slice 2.7 — `apartment_states` (migration 0086). A standing legal/life condition
 * recorded ON an apartment (deceased/dispute/poa/eviction/repairs/rights_transfer)
 * — an ADDITIVE state dimension alongside the locked apartment identity, NOT part of
 * `apartments` and NOT the D.18-locked `apartment_status` enum. The structural mirror
 * of `owner_states` (2.5), adapted to apartments.
 *
 * NO PII (the load-bearing rule of this slice): unlike `owner_states` (encrypted
 * guardian PII), apartment_states carries NO national_id / phone / contact / person
 * identity. A state that conceptually references a person (deceased / poa) captures
 * it ONLY as the `kind` / `subKind` enum + a bounded non-PII `note` label. There is
 * intentionally NO encrypted column and NO contact column — a contact-bearing
 * extension is a SEPARATE future slice; a person involved is an `owner` /
 * `owner_state`, never a column here.
 *
 * RLS: direct org_id isolation, ENABLE + FORCE (migration 0086). Lifecycle =
 * `status` (active/resolved) + `archivedAt` soft-delete; no hard delete
 * (REVOKE DELETE on app_user).
 */
export const apartmentStates = pgTable(
  'apartment_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // The apartment this state attaches to. CASCADE — the state is a fact ABOUT the
    // apartment with no independent meaning (operational soft-delete is archivedAt).
    apartmentId: uuid('apartment_id')
      .notNull()
      .references(() => apartments.id, { onDelete: 'cascade' }),
    kind: apartmentStateKindEnum('kind').notNull(),
    // Optional non-PII refinement label (a sub-type / short reference). The create
    // DTO bounds its length so it stays a label, not a PII payload.
    subKind: text('sub_kind'),
    // Optional bounded NON-PII note (a short description / court reference). The
    // create DTO bounds its length; the caller MUST NOT place PII here. NO encrypted
    // / contact column exists — a person involved is an owner / owner_state.
    note: text('note'),
    status: apartmentStateStatusEnum('status').notNull().default('active'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    // The situation-picture count + recommender working set: ACTIVE, non-archived.
    orgActiveIdx: index('idx_apartment_states_org_active')
      .on(table.orgId, table.kind)
      .where(sql`status = 'active' AND archived_at IS NULL`),
    // Apartment-dossier badge read: active states for one apartment.
    apartmentActiveIdx: index('idx_apartment_states_apartment_active')
      .on(table.apartmentId)
      .where(sql`status = 'active' AND archived_at IS NULL`),
  }),
);

export type ApartmentState = typeof apartmentStates.$inferSelect;
export type NewApartmentState = typeof apartmentStates.$inferInsert;
