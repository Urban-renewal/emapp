import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

import { authSessions } from './auth-sessions';
import { users } from './tenancy';

// PII step-up OTP store (0070, slice 7b-OTP — D-P5.5). Mirrors otp_codes
// (0020): auth-infra, NO RLS (session-keyed, not org-keyed; same posture as
// auth_sessions). Only the HMAC hash of the 6-digit code is stored — NEVER
// plaintext. Single-use (used_at), short expiry, max-5 attempts, 3/15min
// rate-limit derived from created_at. The code is bound to BOTH the user and
// the requesting session — a successful verify stamps ONLY that session's
// auth_sessions.pii_unlocked_at.
export const stepUpCodes = pgTable(
  'step_up_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('idx_step_up_codes_user_created').on(
      table.userId,
      table.createdAt.desc(),
    ),
    sessionCreatedIdx: index('idx_step_up_codes_session_created').on(
      table.sessionId,
      table.createdAt.desc(),
    ),
  }),
);

export type StepUpCode = typeof stepUpCodes.$inferSelect;
export type NewStepUpCode = typeof stepUpCodes.$inferInsert;
