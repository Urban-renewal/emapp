import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

import { providerUsers } from './provider';

// Provider-tier session store (T2.10). Mirrors auth_sessions but FKs the
// separate provider_users identity. Auth infra — no RLS (looked up pre-auth
// by token hash). Only the SHA-256 hash of the opaque refresh token is
// stored. Provider refresh TTL = 4h (Doc07 §6.7), rotation + reuse-detection.
export const providerSessions = pgTable(
  'provider_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerUserId: uuid('provider_user_id')
      .notNull()
      .references(() => providerUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => ({
    userIdx: index('idx_provider_sessions_user').on(table.providerUserId),
  }),
);

export type ProviderSession = typeof providerSessions.$inferSelect;
export type NewProviderSession = typeof providerSessions.$inferInsert;

export const PROVIDER_ACCESS_TTL_SEC = 30 * 60;
export const PROVIDER_REFRESH_TTL_SEC = 4 * 60 * 60;
