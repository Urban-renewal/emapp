import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

import { users } from './tenancy';

// Domain-owned session store (D.21). Replaces the Better Auth ba_session
// hybrid. Auth infrastructure — NOT tenant-scoped, no RLS: lookups happen
// pre-auth (by token hash, before any org context exists). Holds only a
// SHA-256 hash of the opaque refresh token — never the raw token, no PII.
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Rotation chain: set when this token is rotated. A presented token whose
    // row is already revoked WITH replacedBy set = replay of a rotated token
    // → theft signal → revoke the whole chain (reuse detection).
    replacedBy: uuid('replaced_by'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => ({
    userActiveIdx: index('idx_auth_sessions_user').on(table.userId),
  }),
);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
