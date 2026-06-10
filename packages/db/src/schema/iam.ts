import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

import { organizations, users } from './tenancy';

/**
 * Enterprise IAM data model (IAM-DESIGN §3) — Slice 1, PURELY ADDITIVE.
 *
 * Layer 2 (roles) + Layer 3 (assignments) of the three-layer model live here in
 * the DB; Layer 1 (the permission catalog) is a code const
 * (`apps/api/src/common/authz/permissions.ts`). These tables are the
 * load-bearing foundation: seeded + backfilled now, enforced in a LATER slice.
 * `policy.ts` is still the live engine — nothing here changes behavior yet.
 *
 * RLS (mirrors migration 0004 / 0028 FORCE pattern):
 *   - `roles`: org-scoped rows visible to their org; SYSTEM roles
 *     (`org_id IS NULL`) are readable cross-org (every org draws system roles
 *     from the same seeded set).
 *   - `role_permissions` / `role_assignments`: tenant-isolated via the parent.
 */

/**
 * Roles — system (org_id NULL, seeded, un-deletable) or custom (org-owned).
 * `key` is the stable machine identifier (e.g. 'owner', 'manager'); unique per
 * scope: globally unique among system roles, unique per org among custom roles.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = system role (cross-org). Non-null = a custom role owned by an org.
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // System roles: globally unique key (org_id IS NULL).
    systemKeyUnique: uniqueIndex('roles_system_key_unique')
      .on(table.key)
      .where(sql`org_id IS NULL`),
    // Custom roles: unique key per org.
    orgKeyUnique: uniqueIndex('roles_org_key_unique')
      .on(table.orgId, table.key)
      .where(sql`org_id IS NOT NULL`),
    orgIdx: index('idx_roles_org').on(table.orgId),
    // Invariant: system roles have NULL org_id; non-system roles have an org.
    systemOrgCheck: check(
      'roles_system_org_consistent',
      sql`(${table.isSystem} AND ${table.orgId} IS NULL) OR (NOT ${table.isSystem} AND ${table.orgId} IS NOT NULL)`,
    ),
  }),
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

/**
 * Role permissions — the (role × permission) bundle. `permission` is a free
 * text column whose values are the catalog strings
 * (`apps/api/src/common/authz/permissions.ts`); the catalog lives in CODE
 * (§1) so this is intentionally not an enum.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (table) => ({
    pk: uniqueIndex('role_permissions_pk').on(table.roleId, table.permission),
    roleIdx: index('idx_role_permissions_role').on(table.roleId),
  }),
);

export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;

/**
 * Role assignments (IAM-DESIGN §3) — the source of truth for who holds which
 * role on which scope. Backfilled from `memberships.role` (org scope) and
 * `project_assignments` (Agent, project scope).
 *
 * `scope_type ∈ {'org','project'}`; `scope_id` = org_id | project_id. Resolution
 * (§7): an org-scope assignment covers every project in that org; a
 * project-scope assignment covers only that project. Default-deny.
 */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    scopeType: text('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => ({
    scopeTypeCheck: check(
      'role_assignments_scope_type_valid',
      sql`${table.scopeType} IN ('org','project')`,
    ),
    // One active assignment per (user, role, scope) — idempotent backfill +
    // no duplicate grants.
    uniqueAssignment: uniqueIndex('role_assignments_unique').on(
      table.userId,
      table.roleId,
      table.scopeType,
      table.scopeId,
    ),
    userIdx: index('idx_role_assignments_user').on(table.userId),
    scopeIdx: index('idx_role_assignments_scope').on(table.scopeType, table.scopeId),
    roleIdx: index('idx_role_assignments_role').on(table.roleId),
  }),
);

export type RoleAssignment = typeof roleAssignments.$inferSelect;
export type NewRoleAssignment = typeof roleAssignments.$inferInsert;

/**
 * Member permission overrides (P2 Phase 2) — the per-user override layer that
 * sits ON TOP of a member's role-derived permission set.
 *
 * A row is a single (user × permission × scope) override with an `effect`:
 *   - `grant` ADDS a permission the member's roles don't give them.
 *   - `deny`  REMOVES a permission their roles otherwise would.
 * DENY beats GRANT (and beats the role layer) — the engine applies overrides
 * as: `final = (role-derived ∪ GRANT) − DENY`. See `permission.service.ts`.
 *
 * Keyed by `user_id` (NOT membership_id) so it composes directly with the
 * engine, which resolves the actor by `user.id`; `scope_type`/`scope_id` mirror
 * `role_assignments` exactly (org-scope = the org; project-scope = one project)
 * so an override can be scoped as narrowly as a role grant. `permission` is a
 * catalog string (free text, validated in code — `permissions.ts`), exactly
 * like `role_permissions`.
 *
 * UNIQUE on (user, permission, scope_type, scope_id) — there is at most ONE
 * override per permission per scope, so a grant and a deny for the same target
 * can never co-exist (the CRUD layer upserts/replaces; deny-wins is the
 * engine's tiebreak should a stale pair ever appear). Tenant-isolated by scope
 * via FORCE RLS (migration 0061), mirroring `role_assignments`.
 */
export const memberPermissionOverrides = pgTable(
  'member_permission_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    effect: text('effect').notNull(),
    scopeType: text('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    effectCheck: check(
      'member_permission_overrides_effect_valid',
      sql`${table.effect} IN ('grant','deny')`,
    ),
    scopeTypeCheck: check(
      'member_permission_overrides_scope_type_valid',
      sql`${table.scopeType} IN ('org','project')`,
    ),
    // At most ONE override per (user, permission, scope) — a grant + a deny for
    // the same target can never both exist.
    uniqueOverride: uniqueIndex('member_permission_overrides_unique').on(
      table.userId,
      table.permission,
      table.scopeType,
      table.scopeId,
    ),
    userIdx: index('idx_member_permission_overrides_user').on(table.userId),
    scopeIdx: index('idx_member_permission_overrides_scope').on(table.scopeType, table.scopeId),
  }),
);

export type MemberPermissionOverride = typeof memberPermissionOverrides.$inferSelect;
export type NewMemberPermissionOverride = typeof memberPermissionOverrides.$inferInsert;
