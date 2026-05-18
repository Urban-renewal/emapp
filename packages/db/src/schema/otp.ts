import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

import { owners } from './projects';
import { organizations } from './tenancy';

// Tenant SMS OTP store (D.20). Auth-infra, no RLS (pre-auth lookup by
// phone hash). Only HMAC hashes of phone+code are stored — never plaintext.
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phoneHash: text('phone_hash').notNull(),
    codeHash: text('code_hash').notNull(),
    ownerId: uuid('owner_id').references(() => owners.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phoneCreatedIdx: index('idx_otp_phone_created').on(table.phoneHash, table.createdAt.desc()),
  }),
);

export type OtpCode = typeof otpCodes.$inferSelect;
export type NewOtpCode = typeof otpCodes.$inferInsert;
