import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

import { owners } from './projects';
import { organizations } from './tenancy';

// Domain-owned session store for the Tenant Portal tier (Wave 4 M-1,
// migration 0038). Mirrors `auth_sessions` for the org tier: auth
// infrastructure — NOT tenant-scoped, no RLS. The pre-auth lookup
// happens BEFORE the guard sets app.organization_id (we don't know the
// org yet — the JWT claim is what TELLS us). Cross-org forgery is
// blocked by the JWT signature, not by RLS.
//
// Soft revoke via `revoked_at`; no DELETE granted (CLAUDE.md hard rule).
export const tenantSessions = pgTable(
  'tenant_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => ({
    ownerIdx: index('idx_tenant_sessions_owner').on(table.ownerId),
  }),
);

export type TenantSession = typeof tenantSessions.$inferSelect;
export type NewTenantSession = typeof tenantSessions.$inferInsert;
