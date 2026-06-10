import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './tenancy';

// Self-service org password-reset store (P1 R0.1, OWASP Forgot-Password).
// Auth infrastructure — NOT tenant-scoped, NO RLS: the reset flow runs
// PRE-AUTH (no session, no org context), read/written only by the raw `db`
// BYPASSRLS role from AuthService. Same posture as auth_sessions (D.21).
// Holds ONLY a SHA-256 hash of the opaque raw token — never the raw token,
// no PII. Single-use (used_at), short expiry (<=30 min, set by the service).
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set the instant the token is consumed → single-use guard (a presented
    // token whose row already has used_at set is rejected).
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Best-effort source IP of the forgot-password request (audit/abuse only;
    // never used for auth decisions). NOT PII-encrypted — an IP is operational
    // metadata, same posture as auth_sessions.ip.
    requestedIp: text('requested_ip'),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('idx_password_reset_tokens_token_hash').on(table.tokenHash),
    userIdx: index('idx_password_reset_tokens_user').on(table.userId),
  }),
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
