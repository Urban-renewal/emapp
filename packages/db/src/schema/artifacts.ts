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
