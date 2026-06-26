import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

import { ownerStateKindEnum, ownerStateStatusEnum } from './_enums';
import { bytea } from './_types';
import { owners } from './projects';
import { organizations, users } from './tenancy';

/**
 * Slice 2.5 — `owner_states` (migration 0084). A standing legal/life condition
 * recorded ON an owner (competency/dispute/transfer/lien/verify/consent_withdrawal)
 * — an ADDITIVE state dimension alongside the locked owner identity, NOT part of
 * `owners`.
 *
 * GUARDIAN PII (the load-bearing rule of this slice): `guardian_*_encrypted` are
 * pgcrypto-encrypted bytea MIRRORING `owners.national_id_encrypted` — written via
 * `encryptField` (key PII_ENCRYPTION_KEY), read via `decryptField` and ALWAYS
 * masked before crossing the wire. There is NO guardian hash column (no lookup
 * need) and NO reveal endpoint in this slice. Cleartext is NEVER logged, NEVER in
 * proposal evidence / audit afterState.
 *
 * RLS: direct org_id isolation, ENABLE + FORCE (migration 0084). Lifecycle =
 * `status` (active/resolved) + `archivedAt` soft-delete; no hard delete
 * (REVOKE DELETE on app_user).
 */
export const ownerStates = pgTable(
  'owner_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // The owner this state attaches to. CASCADE — the state is a fact ABOUT the
    // owner with no independent meaning (operational soft-delete is archivedAt).
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    kind: ownerStateKindEnum('kind').notNull(),
    // Optional non-PII refinement label (a sub-type / short reference). The create
    // DTO bounds its length so it stays a label, not a PII payload.
    subKind: text('sub_kind'),
    // ── Guardian PII — pgcrypto-encrypted at rest (mirror owners.national_id_encrypted).
    // Only meaningful for `competency`; NULL otherwise. NEVER returned cleartext.
    guardianNameEncrypted: bytea('guardian_name_encrypted'),
    guardianPhoneEncrypted: bytea('guardian_phone_encrypted'),
    guardianNationalIdEncrypted: bytea('guardian_national_id_encrypted'),
    status: ownerStateStatusEnum('status').notNull().default('active'),
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
    orgActiveIdx: index('idx_owner_states_org_active')
      .on(table.orgId, table.kind)
      .where(sql`status = 'active' AND archived_at IS NULL`),
    // Owner-detail badge read: active states for one owner.
    ownerActiveIdx: index('idx_owner_states_owner_active')
      .on(table.ownerId)
      .where(sql`status = 'active' AND archived_at IS NULL`),
  }),
);

export type OwnerState = typeof ownerStates.$inferSelect;
export type NewOwnerState = typeof ownerStates.$inferInsert;
