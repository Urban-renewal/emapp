import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';

import { externalSharePartyTypeEnum, externalShareScopeTypeEnum } from './_enums';
import { organizations, users } from './tenancy';

/**
 * X-S2 (V13) — `external_share`: the generalized, party-TYPED external-sharing
 * grant. Supersedes the contractor-only `shares` table (org→contractor→project,
 * JSONB perms) by adding a `party_type` taxonomy + a `scope_type`/`scope_ids`
 * addressing model, so a grant can target a developer / lawyer / bank / etc.
 * over a project, building, or apartment set — not just a contractor over a
 * whole project.
 *
 * NOTE (migration posture): this table is ADDITIVE. The contractor tier keeps
 * running on the existing `shares` table + `ShareTokenService` until a
 * deliberate parity-proven migration (X-S8, Wave D). Nothing in this slice
 * touches `shares`.
 *
 * Authorization model:
 *   - RLS FORCE org isolation (org_id GUC) — the hard boundary, mirroring every
 *     other tenant table (see migration 0077).
 *   - The SCOPE+PERMISSIONS a grant may carry is bounded SERVER-SIDE by the
 *     party_type's preset CEILING (`PARTY_PRESET_CEILINGS` below). The service
 *     re-validates every create/update against the ceiling, fail-closed, and
 *     can only NARROW — never widen.
 *   - `allow_sensitive` is a SEPARATE, default-OFF switch (PII / sensitive-doc
 *     bytes) — a party whose ceiling forbids sensitive access can never set it.
 *
 * Lifecycle = `revoked_at` (immediate, no physical delete) + `expires_at` (TTL).
 * `otp_required` carries the OTP-access flag at the MODEL level only — the OTP
 * gate itself is X-S4. Owner-scoped package sharing is OUT of this slice.
 */
export const externalShares = pgTable(
  'external_share',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    partyType: externalSharePartyTypeEnum('party_type').notNull(),
    scopeType: externalShareScopeTypeEnum('scope_type').notNull(),
    // The concrete projects/buildings/apartments this grant addresses. Their
    // KIND is `scope_type`. RLS guarantees org isolation; the service validates
    // that every id resolves inside the caller's org before insert.
    scopeIds: uuid('scope_ids').array().notNull(),
    // Narrowed-from-ceiling permission grant (validated by the service against
    // the party preset ceiling). Strict-Zod shape: `ExternalSharePermissions`.
    permissions: jsonb('permissions').$type<ExternalSharePermissions>().notNull(),
    // Sensitive-byte access (PII / decrypt-stream). Default OFF; only a party
    // whose ceiling permits sensitive may turn it on (service-enforced).
    allowSensitive: boolean('allow_sensitive').notNull().default(false),
    // OTP access flag (X-S4 honors it). Org default-ON; carried here so a
    // per-share narrow (turning it off) is possible only where the org allows.
    otpRequired: boolean('otp_required').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Per-recipient watermark subject (X-S5 overlay). Free text, never PII-keyed.
    watermarkSubject: text('watermark_subject'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // org list / keyset pagination on active grants.
    orgActiveIdx: index('idx_external_share_org_active')
      .on(table.orgId, table.createdAt.desc(), table.id.desc())
      .where(sql`revoked_at IS NULL`),
    orgPartyIdx: index('idx_external_share_org_party')
      .on(table.orgId, table.partyType)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type ExternalShare = typeof externalShares.$inferSelect;
export type NewExternalShare = typeof externalShares.$inferInsert;

export type ExternalSharePartyType = (typeof externalSharePartyTypeEnum.enumValues)[number];
export type ExternalShareScopeType = (typeof externalShareScopeTypeEnum.enumValues)[number];

/**
 * The permission surface an external grant can expose. Mirrors the contractor
 * `SharePermissions` on/actions shape but generalized: each resource is a flag
 * with optional download capability. `sensitive` documents are gated SEPARATELY
 * by the row-level `allow_sensitive` column (NOT a permission flag) so the
 * sensitive switch is impossible to set via the JSONB alone.
 *
 * The canonical Zod validator lives in `@emapp/shared-types`
 * (`ExternalSharePermissionsSchema`) — this type is its structural twin for the
 * Drizzle `$type<>()` binding. They MUST stay byte-equivalent (same enforcement
 * posture as `SharePermissions`).
 */
export interface ExternalSharePermissions {
  /** Project/scope overview (status, headline progress). */
  overview: { on: boolean };
  /** Documents list + optional download of NON-sensitive docs. */
  documents: { on: boolean; actions: { download: boolean } };
  /** Signature progress (counts/status — not the signature blobs). */
  signatures: { on: boolean };
}

/**
 * X-S2/X-S3 — server-side PRESET CEILINGS per party_type: the WIDEST scope_type
 * and permission set each party may EVER be granted. The service re-validates
 * every create/update against this map and can only NARROW (never widen). This
 * is the fail-closed authorization spine — a client request that asks for more
 * than the ceiling is REJECTED, not silently clamped.
 *
 * Design intent per party (conservative defaults; widen only on explicit
 * product sign-off):
 *   - developer / developer_lawyer: project-wide, full read + download,
 *     sensitive ALLOWED (they are the principal counterpARTY to the deal).
 *   - tenant_lawyer: project-wide read + download, sensitive ALLOWED (acts for
 *     residents; needs the executed instruments).
 *   - bank: project-wide overview + documents download (guarantees / חוק המכר),
 *     sensitive ALLOWED; signatures OFF (not their concern).
 *   - supervisor (מפקח): project-wide read, sensitive ALLOWED; download ON.
 *   - appraiser / surveyor: APARTMENT-scoped only, overview + documents, NO
 *     sensitive — they value/measure specific apartments, never the whole deal.
 *   - committee (נציגות): project-wide overview + signatures progress, NO
 *     documents download, NO sensitive — residents' reps see progress, not the
 *     legal/PII payload.
 *   - special_admin (כונס/מנהל מיוחד): project-wide, full read + download,
 *     sensitive ALLOWED (court-appointed broad authority).
 *
 * `maxScopeType` encodes the WIDEST granularity: 'project' ⊇ 'building' ⊇
 * 'apartment'. A ceiling of 'apartment' means the party may ONLY be apartment-
 * scoped (never project/building-wide). `permissions` is the per-flag MAXIMUM
 * (true = may be on; false = must stay off). `allowSensitive` is the sensitive
 * ceiling. `maxTtlDays` caps `expires_at` (null = no hard cap).
 */
export interface PartyPresetCeiling {
  maxScopeType: ExternalShareScopeType;
  permissions: ExternalSharePermissions;
  allowSensitive: boolean;
  maxTtlDays: number | null;
}

const FULL_READ_DOWNLOAD: ExternalSharePermissions = {
  overview: { on: true },
  documents: { on: true, actions: { download: true } },
  signatures: { on: true },
};

export const PARTY_PRESET_CEILINGS: Record<ExternalSharePartyType, PartyPresetCeiling> = {
  developer: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  developer_lawyer: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  tenant_lawyer: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  bank: {
    maxScopeType: 'project',
    permissions: {
      overview: { on: true },
      documents: { on: true, actions: { download: true } },
      signatures: { on: false },
    },
    allowSensitive: true,
    maxTtlDays: 365,
  },
  supervisor: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
  appraiser: {
    maxScopeType: 'apartment',
    permissions: {
      overview: { on: true },
      documents: { on: true, actions: { download: true } },
      signatures: { on: false },
    },
    allowSensitive: false,
    maxTtlDays: 90,
  },
  surveyor: {
    maxScopeType: 'apartment',
    permissions: {
      overview: { on: true },
      documents: { on: true, actions: { download: true } },
      signatures: { on: false },
    },
    allowSensitive: false,
    maxTtlDays: 90,
  },
  committee: {
    maxScopeType: 'project',
    permissions: {
      overview: { on: true },
      documents: { on: false, actions: { download: false } },
      signatures: { on: true },
    },
    allowSensitive: false,
    maxTtlDays: 365,
  },
  special_admin: {
    maxScopeType: 'project',
    permissions: FULL_READ_DOWNLOAD,
    allowSensitive: true,
    maxTtlDays: 365,
  },
};
