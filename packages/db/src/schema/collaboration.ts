import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  smallint,
  integer,
  check,
} from 'drizzle-orm/pg-core';

import { taskStatusEnum, notificationTypeEnum } from './_enums';
import type { SharePermissions } from './_share-permissions';
import { citext } from './_types';
import { apartments, owners, projects } from './projects';
import { organizations, users } from './tenancy';

export const contractors = pgTable(
  'contractors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    contactEmail: citext('contact_email').notNull(),
    contactPhone: text('contact_phone'),
    companyId: text('company_id'),
    specialty: text('specialty'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    uniqueEmailPerOrg: uniqueIndex('contractors_org_email_active')
      .on(table.orgId, table.contactEmail)
      .where(sql`archived_at IS NULL`),
    orgIdx: index('idx_contractors_org')
      .on(table.orgId)
      .where(sql`archived_at IS NULL`),
  }),
);

export type Contractor = typeof contractors.$inferSelect;
export type NewContractor = typeof contractors.$inferInsert;

export const shares = pgTable(
  'shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    contractorId: uuid('contractor_id')
      .notNull()
      .references(() => contractors.id, { onDelete: 'cascade' }),
    permissions: jsonb('permissions').$type<SharePermissions>().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueActive: uniqueIndex('shares_project_contractor_active')
      .on(table.projectId, table.contractorId)
      .where(sql`revoked_at IS NULL`),
    contractorActiveIdx: index('idx_shares_contractor_active')
      .on(table.contractorId)
      .where(sql`revoked_at IS NULL`),
    projectIdx: index('idx_shares_project_active')
      .on(table.projectId)
      .where(sql`revoked_at IS NULL`),
  }),
);

export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    apartmentId: uuid('apartment_id').references(() => apartments.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    type: text('type').notNull().default('general'),
    status: taskStatusEnum('status').notNull().default('pending'),
    priority: smallint('priority').notNull().default(2),
    dueAt: timestamp('due_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes'),
    // D.38 / V11 B.S5 — calendar event start (distinct from dueAt which
    // is the soft deadline). When set, the task participates in the
    // WeekCalendar grid + drives the ICS DTSTART.
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    // D.38 — optional ICS LOCATION (free text, no geocoding).
    location: text('location'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    orgStatusIdx: index('idx_tasks_org_status')
      .on(table.orgId, table.status)
      .where(sql`archived_at IS NULL`),
    orgDueIdx: index('idx_tasks_org_due')
      .on(table.orgId, table.dueAt)
      .where(sql`archived_at IS NULL AND due_at IS NOT NULL`),
    // D.38 — WeekCalendar week-of-X hot lookup.
    orgScheduledIdx: index('idx_tasks_org_scheduled')
      .on(table.orgId, table.scheduledAt)
      .where(sql`archived_at IS NULL AND scheduled_at IS NOT NULL`),
    projectIdx: index('idx_tasks_project')
      .on(table.projectId)
      .where(sql`project_id IS NOT NULL`),
    // 2026-05-27 manager-be perf audit M1: ORDER BY created_at DESC
    // had no matching index; planner fell back to in-RAM sort.
    // Mirrored in migration 0037.
    orgCreatedIdx: index('idx_tasks_org_created')
      .on(table.orgId, table.createdAt.desc(), table.id.desc())
      .where(sql`archived_at IS NULL`),
    priorityCheck: check('tasks_priority_range', sql`${table.priority} BETWEEN 1 AND 3`),
  }),
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

export const taskAssignees = pgTable(
  'task_assignees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (table) => ({
    unique: uniqueIndex('task_assignees_task_user_unique').on(table.taskId, table.userId),
    userIdx: index('idx_task_assignees_user').on(table.userId),
  }),
);

export type TaskAssignee = typeof taskAssignees.$inferSelect;
export type NewTaskAssignee = typeof taskAssignees.$inferInsert;

// D.41 / V11 B.S5 — task_external_attendees. SEPARATE table from
// task_assignees (which links to `users`) because the semantics + FK
// tier are different:
//   - task_assignees:           internal users who DO the task (Manager / Agent)
//   - task_external_attendees:  Tier-2 owners INVITED to the ICS event
// Polymorphic FK or a shared "any-actor" table would conflate "actor"
// and "invitee" and lose the audit/tier signal. The split is the
// architectural choice authorized inline at the B.S1 GO answer Q3.
//
// ics_sent_at / ics_cancelled_at are the idempotency + audit trail
// columns used by B.S7 Resend integration: each successful send /
// cancel updates the timestamp so a crash between send and audit-log
// can resume safely without double-sending.
export const taskExternalAttendees = pgTable(
  'task_external_attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    icsSentAt: timestamp('ics_sent_at', { withTimezone: true }),
    icsCancelledAt: timestamp('ics_cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unique: uniqueIndex('task_external_attendees_task_owner_unique').on(
      table.taskId,
      table.ownerId,
    ),
    ownerIdx: index('idx_task_external_attendees_owner').on(table.ownerId),
  }),
);

export type TaskExternalAttendee = typeof taskExternalAttendees.$inferSelect;
export type NewTaskExternalAttendee = typeof taskExternalAttendees.$inferInsert;

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUnreadIdx: index('idx_notifications_user_unread')
      .on(table.userId, table.createdAt.desc())
      .where(sql`read_at IS NULL`),
    userAllIdx: index('idx_notifications_user_all').on(table.userId, table.createdAt.desc()),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

export const projectAssignments = pgTable(
  'project_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    roleInProject: text('role_in_project').notNull().default('agent'),
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp('unassigned_at', { withTimezone: true }),
  },
  (table) => ({
    uniqueActive: uniqueIndex('project_assignments_project_user_active')
      .on(table.projectId, table.userId)
      .where(sql`unassigned_at IS NULL`),
    userIdx: index('idx_project_assignments_user_active')
      .on(table.userId)
      .where(sql`unassigned_at IS NULL`),
    projectIdx: index('idx_project_assignments_project_active')
      .on(table.projectId)
      .where(sql`unassigned_at IS NULL`),
  }),
);

export type ProjectAssignment = typeof projectAssignments.$inferSelect;
export type NewProjectAssignment = typeof projectAssignments.$inferInsert;
