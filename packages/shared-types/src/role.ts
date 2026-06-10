import { z } from 'zod';

/**
 * Custom roles (org-defined permission groups) — P2 Phase 1.
 *
 * The IAM engine (apps/api PermissionService) ALREADY resolves any role —
 * system or org-custom — from `role_assignments ⋈ role_permissions`. These
 * wire shapes drive the MANAGEMENT CRUD + assign/revoke surface on top of the
 * existing data model (`roles.org_id` set ⇒ org-custom; NULL ⇒ system).
 *
 * The permission catalog itself lives in CODE on the BE
 * (`apps/api/src/common/authz/permissions.ts`) because each string binds to a
 * real enforcement point. The wire contract here treats a permission as an
 * opaque non-empty string; the BE validates each against the catalog (a
 * not-a-real-permission string is rejected) AND against the anti-escalation
 * boundary (subset of the actor's effective set; no `org.*` or `roles.*` unless the
 * actor is an Owner). The FE fetches the grantable catalog from the BE
 * (GET /roles/catalog) so it never hardcodes the permission list.
 */

/** A single permission string (catalog membership is validated server-side). */
export const PermissionString = z.string().min(1).max(128);

/**
 * A role as returned by the management surface — system OR org-custom. `key`
 * is the stable machine id (system: 'owner'…'external_read'; custom: a
 * slug derived from the name). `isSystem` marks the un-editable seeded roles.
 */
export const RoleSummarySchema = z.object({
  id: z.string().uuid(),
  /** NULL for system roles (cross-org); the org id for custom roles. */
  orgId: z.string().uuid().nullable(),
  key: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullable(),
  isSystem: z.boolean(),
  /** The exact granted permission set (catalog strings), sorted. */
  permissions: z.array(PermissionString),
  /** How many active assignments reference this role (drives delete-guard UI). */
  assignmentCount: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type RoleSummary = z.infer<typeof RoleSummarySchema>;

/** GET /roles — list system + custom roles for the caller's org. */
export const RoleListSchema = z.object({ data: z.array(RoleSummarySchema) });
export type RoleList = z.infer<typeof RoleListSchema>;

/**
 * A grantable permission descriptor (GET /roles/catalog). `resource` is the
 * prefix before the first dot (e.g. 'projects'); the FE groups the picker by
 * it. `governance` flags `org.*` and `roles.*` permissions the FE should render as
 * Owner-only (the BE still enforces; this is purely a UI affordance).
 */
export const PermissionCatalogEntrySchema = z.object({
  permission: PermissionString,
  resource: z.string().min(1).max(64),
  governance: z.boolean(),
});
export type PermissionCatalogEntry = z.infer<typeof PermissionCatalogEntrySchema>;

export const PermissionCatalogSchema = z.object({
  data: z.array(PermissionCatalogEntrySchema),
});
export type PermissionCatalog = z.infer<typeof PermissionCatalogSchema>;

/**
 * POST /roles — create an org-custom role. `name` is the human label; the BE
 * derives the machine `key` (unique per org). `permissions` must be a SUBSET
 * of the creating actor's effective permissions and obey the `org.*` / `roles.*`
 * boundary — enforced server-side (a violation is a 403/422, never silently
 * trimmed).
 */
export const CreateCustomRoleInput = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(280).optional(),
    permissions: z.array(PermissionString).min(1).max(200),
  })
  .strict();
export type CreateCustomRole = z.infer<typeof CreateCustomRoleInput>;

/**
 * PATCH /roles/:id — rename and/or replace the permission set of an org-custom
 * role. At least one field. `permissions`, when present, REPLACES the set and
 * is re-validated against the subset + governance boundary. A system role can
 * never be the target (404/422).
 */
export const UpdateCustomRoleInput = z
  .object({
    name: z.string().min(2).max(80).optional(),
    description: z.string().max(280).nullable().optional(),
    permissions: z.array(PermissionString).min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (o) => o.name !== undefined || o.description !== undefined || o.permissions !== undefined,
    {
      message: 'at least one field must be provided',
    },
  );
export type UpdateCustomRole = z.infer<typeof UpdateCustomRoleInput>;

/**
 * POST /roles/assignments — grant a role (system or custom) to a member at org
 * scope. The engine enforces it live on the target's next request. Gated by
 * `roles.assign`; subject to the same no-self-escalation tier guard the member
 * surface uses (only an Owner may grant Owner/Admin).
 */
export const AssignRoleInput = z
  .object({
    userId: z.string().uuid(),
    roleId: z.string().uuid(),
  })
  .strict();
export type AssignRole = z.infer<typeof AssignRoleInput>;

/** DELETE /roles/assignments — revoke a specific (user, role) org-scope grant. */
export const RevokeRoleInput = z
  .object({
    userId: z.string().uuid(),
    roleId: z.string().uuid(),
  })
  .strict();
export type RevokeRole = z.infer<typeof RevokeRoleInput>;
