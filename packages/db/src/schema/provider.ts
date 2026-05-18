import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';

import { bytea, citext, inet } from './_types';

export const providerUsers = pgTable(
  'provider_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('admin'),
    mfaSecretEncrypted: bytea('mfa_secret_encrypted').notNull(),
    recoveryCodesHash: jsonb('recovery_codes_hash').$type<string[]>().notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailActiveIdx: index('idx_provider_users_email_active')
      .on(table.email)
      .where(sql`disabled_at IS NULL`),
  }),
);

export type ProviderUser = typeof providerUsers.$inferSelect;
export type NewProviderUser = typeof providerUsers.$inferInsert;

export const providerAuditLog = pgTable(
  'provider_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerUserId: uuid('provider_user_id')
      .notNull()
      .references(() => providerUsers.id),
    reason: text('reason').notNull(),
    actionType: text('action_type').notNull(),
    targetTable: text('target_table'),
    targetRecordId: uuid('target_record_id'),
    affectedOrgs: uuid('affected_orgs').array(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    queryCount: integer('query_count').default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    userTimeIdx: index('idx_provider_audit_user_time').on(
      table.providerUserId,
      table.startedAt.desc(),
    ),
    affectedOrgsIdx: index('idx_provider_audit_affected_orgs').using('gin', table.affectedOrgs),
  }),
);

export type ProviderAuditEntry = typeof providerAuditLog.$inferSelect;
export type NewProviderAuditEntry = typeof providerAuditLog.$inferInsert;
