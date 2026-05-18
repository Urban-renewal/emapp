import { uuid, timestamp } from 'drizzle-orm/pg-core';

export const commonColumns = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

// For multi-tenant tables — adds org_id FK referencing the organizations table.
// Pass the organizations table reference to avoid circular imports.
export const tenantColumns = (organizationsTable: { id: ReturnType<typeof uuid> }) => ({
  ...commonColumns(),
  orgId: uuid('org_id')
    .notNull()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .references(() => (organizationsTable as any).id, { onDelete: 'restrict' }),
});
