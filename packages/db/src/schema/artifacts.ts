import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { bytea } from './_types';
import { contractors } from './collaboration';
import { apartments, projects } from './projects';
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
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    orgIdx: index('idx_documents_org')
      .on(table.orgId)
      .where(sql`archived_at IS NULL`),
    projectIdx: index('idx_documents_project')
      .on(table.projectId)
      .where(sql`project_id IS NOT NULL AND archived_at IS NULL`),
    apartmentIdx: index('idx_documents_apartment')
      .on(table.apartmentId)
      .where(sql`apartment_id IS NOT NULL AND archived_at IS NULL`),
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
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    apartmentId: uuid('apartment_id')
      .notNull()
      .references(() => apartments.id, { onDelete: 'restrict' }),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    signatureBlob: bytea('signature_blob').notNull(),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'restrict' }),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('idx_signatures_project').on(table.projectId),
    apartmentIdx: index('idx_signatures_apartment').on(table.apartmentId),
    uniquePerApartmentProject: uniqueIndex('signatures_apartment_project_unique').on(
      table.apartmentId,
      table.projectId,
    ),
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
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorContractorId: uuid('actor_contractor_id').references(() => contractors.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgCreatedIdx: index('idx_audit_log_org_created').on(table.orgId, table.createdAt.desc()),
    entityIdx: index('idx_audit_log_entity').on(table.entityType, table.entityId),
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
