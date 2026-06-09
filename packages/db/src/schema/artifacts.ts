import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { bytea, inet } from './_types';
import { apartments, owners, projects } from './projects';
import { organizations, users } from './tenancy';

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    apartmentId: uuid('apartment_id').references(() => apartments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    r2Key: text('r2_key').notNull(),
    contentHash: text('content_hash').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** 0049 — set by a SUCCESSFUL finalize. NULL = bytes not confirmed in R2;
     *  serving read paths require this NOT NULL so a never-finalised "ghost"
     *  document is never listed/downloaded (was the NoSuchKey bug). */
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  },
  (table) => ({
    r2KeyUnique: uniqueIndex('documents_r2_key_unique').on(table.r2Key),
    orgProjectIdx: index('idx_documents_org_project')
      .on(table.orgId, table.projectId)
      .where(sql`archived_at IS NULL`),
    apartmentIdx: index('idx_documents_apartment')
      .on(table.apartmentId)
      .where(sql`apartment_id IS NOT NULL AND archived_at IS NULL`),
    contentHashIdx: index('idx_documents_content_hash').on(table.contentHash),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export const signatures = pgTable(
  'signatures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    documentHash: text('document_hash').notNull(),
    signatureBlob: bytea('signature_blob').notNull(),
    // D.12 (LAW): signatures are SVG.
    signatureFormat: text('signature_format').notNull().default('svg'),
    signerIp: inet('signer_ip'),
    signerUserAgent: text('signer_user_agent'),
    sessionId: uuid('session_id'),
    authMethod: text('auth_method').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('idx_signatures_document').on(table.documentId),
    ownerIdx: index('idx_signatures_owner').on(table.ownerId),
  }),
);

export type Signature = typeof signatures.$inferSelect;
export type NewSignature = typeof signatures.$inferInsert;

/**
 * Phase 5 — signature_requests: drives the public-link signing flow.
 *
 * Manager creates a request → server mints a JWT signed with
 * SIGNATURE_TOKEN_SECRET (separate from JWT_SECRET, see docs/03 §9) →
 * link is delivered to the resident via Email/WhatsApp/SMS → resident
 * opens `/sign/[token]` → POSTs the SVG → atomic single-use UPDATE
 * (WHERE jti=? AND status='pending') flips status to 'signed' and the
 * actual signature row lands in the `signatures` table.
 *
 * Status machine: pending → signed | cancelled. Once 'signed' or
 * 'cancelled', the row is forensic evidence — only the status fields
 * change (the row itself is never deleted; no `archived_at`).
 */
export const signatureRequests = pgTable(
  'signature_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    /** JWT `jti` claim. UNIQUE — this is the atomic single-use guard's key. */
    jti: text('jti').notNull(),
    /** 'pending' | 'signed' | 'cancelled' — enforced by CHECK in migration 0021. */
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /** Links to the actual encrypted-SVG row in `signatures` once signed. */
    signedSignatureId: uuid('signed_signature_id').references(() => signatures.id, {
      onDelete: 'restrict',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
  },
  (table) => ({
    jtiUnique: uniqueIndex('signature_requests_jti_unique').on(table.jti),
    orgStatusCreatedIdx: index('idx_signature_requests_org_status_created').on(
      table.orgId,
      table.status,
      table.createdAt.desc(),
    ),
    docStatusIdx: index('idx_signature_requests_doc_status').on(table.documentId, table.status),
    ownerStatusIdx: index('idx_signature_requests_owner_status').on(table.ownerId, table.status),
    statusCheck: check(
      'signature_requests_status_valid',
      sql`${table.status} IN ('pending','signed','cancelled')`,
    ),
  }),
);

export type SignatureRequest = typeof signatureRequests.$inferSelect;
export type NewSignatureRequest = typeof signatureRequests.$inferInsert;

/**
 * P0.C2 — PII-PROCESSING consent / privacy-notice acknowledgment trail
 * (Israeli Privacy Protection Law — recorded lawful basis / notice).
 *
 * DISTINCT from D.57 "valid-consent" (the SIGNATURE-threshold % of owners):
 * that is a project-level signature target; THIS is the per-resident record
 * that an apartment owner was shown — and acknowledged — the org's
 * PII-processing privacy notice at a point in time.
 *
 * The notice TEXT is configurable per-org (OrgSettings `privacy` namespace —
 * NOT hardcoded legal copy). This table is the immutable EVIDENCE: it pins the
 * exact `noticeVersion` AND a `noticeHash` (SHA-256 of the precise text the
 * resident saw) so the record is self-verifying even if the org later edits
 * its notice text. No new PII beyond the owner ref + request provenance
 * (IP/UA) — consistent with how `signatures` captures provenance.
 *
 * APPEND-ONLY / IMMUTABLE: INSERT + SELECT only (migration 0059 REVOKEs
 * UPDATE/DELETE from app_user). A consent, once given, is never mutated or
 * deleted — it is a forensic compliance record. No `archived_at`.
 *
 * Org-scoped: FORCE RLS `tenant_isolation` on `org_id` (migration 0059),
 * exactly mirroring owners/signatures.
 */
export const piiProcessingConsents = pgTable(
  'pii_processing_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The subject — the apartment owner (resident) who acknowledged. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    /** The notice version the resident acknowledged (from OrgSettings.privacy
     *  `noticeVersion`). Immutable string label, e.g. 'v1'. */
    noticeVersion: text('notice_version').notNull(),
    /** SHA-256 (hex) of the EXACT notice text shown to the resident. Pins the
     *  content immutably even if the org edits its configurable notice copy. */
    noticeHash: text('notice_hash').notNull(),
    /** The capture surface / method, e.g. 'public_sign_v1'. */
    method: text('method').notNull(),
    /** Provenance — same posture as `signatures.signerIp` / `signerUserAgent`. */
    consentIp: inet('consent_ip'),
    consentUserAgent: text('consent_user_agent'),
    /** When the acknowledgment happened (the signing moment). */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgOwnerIdx: index('idx_pii_consents_org_owner').on(table.orgId, table.ownerId),
    ownerAckIdx: index('idx_pii_consents_owner_ack').on(table.ownerId, table.acknowledgedAt.desc()),
  }),
);

export type PiiProcessingConsent = typeof piiProcessingConsents.$inferSelect;
export type NewPiiProcessingConsent = typeof piiProcessingConsents.$inferInsert;

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    apartmentId: uuid('apartment_id').references(() => apartments.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    isPinned: text('is_pinned'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    projectIdx: index('idx_notes_project')
      .on(table.projectId)
      .where(sql`project_id IS NOT NULL AND archived_at IS NULL`),
    apartmentIdx: index('idx_notes_apartment')
      .on(table.apartmentId)
      .where(sql`apartment_id IS NOT NULL AND archived_at IS NULL`),
  }),
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }), // null = system
    actorType: text('actor_type').notNull(),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    targetTable: text('target_table'),
    targetId: uuid('target_id'),
    beforeState: jsonb('before_state').$type<Record<string, unknown>>(),
    afterState: jsonb('after_state').$type<Record<string, unknown>>(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    sessionId: uuid('session_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgTimeIdx: index('idx_audit_org_time').on(table.orgId, table.createdAt.desc()),
    actorIdx: index('idx_audit_actor').on(table.actorId, table.createdAt.desc()),
    targetIdx: index('idx_audit_target').on(table.targetTable, table.targetId),
    actorTypeCheck: check(
      'audit_log_actor_type_valid',
      sql`${table.actorType} IN ('user','system','provider')`,
    ),
  }),
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

export const cacheKv = pgTable(
  'cache_kv',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').$type<unknown>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresIdx: index('idx_cache_kv_expires').on(table.expiresAt),
  }),
);

export type CacheKv = typeof cacheKv.$inferSelect;
export type NewCacheKv = typeof cacheKv.$inferInsert;
