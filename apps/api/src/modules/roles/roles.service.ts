import {
  AuditService,
  authSessions,
  memberships,
  roleAssignments,
  rolePermissions,
  roles,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type {
  AssignRole,
  CreateCustomRole,
  PermissionCatalogEntry,
  RevokeRole,
  RoleSummary,
  UpdateCustomRole,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  PermissionResolutionCache,
  PermissionService,
  type AuthzUser,
} from '../../common/authz/permission.service';
import { PERMISSIONS, type Permission } from '../../common/authz/permissions';
import type { AccessTokenPayload } from '../auth/auth.service';
import { flushSessionCache } from '../auth/session-validity';

import {
  actorIsOwner,
  checkCustomRolePermissions,
  checkRoleAssignable,
  isGovernancePermission,
} from './custom-role-authz';

const NOT_FOUND = new NotFoundException({ error: { code: 'role_not_found' } });
const SYSTEM_IMMUTABLE = new UnprocessableEntityException({
  error: { code: 'system_role_immutable', message: 'System roles cannot be edited or deleted.' },
});
const ROLE_IN_USE = new ConflictException({
  error: { code: 'role_in_use', message: 'Role has active assignments and cannot be deleted.' },
});
const LAST_OWNER = new BadRequestException({ error: { code: 'cannot_revoke_last_owner' } });

/**
 * Custom-role management — P2 Phase 1. The MANAGEMENT CRUD + assign/revoke for
 * org-custom roles, layered on the EXISTING IAM data model. The engine
 * (`PermissionService`) already enforces any role the moment a `role_assignment`
 * references it; this service does NOT touch the engine — it administers the
 * `roles` / `role_permissions` / `role_assignments` rows.
 *
 * Every method runs inside `withTenant(orgId)` so RLS scopes the rows to the
 * caller's org (a custom role is ALWAYS org-scoped: `org_id = actor.orgId`,
 * never NULL, never cross-tenant — RLS WITH CHECK on `roles` enforces this at
 * the DB level too). All mutations are audited. Responses use the `{data}`
 * envelope at the controller.
 *
 * SECURITY: create + permission-changing update funnel through
 * `assertPermissionsAllowed`, which resolves the ACTOR's effective set live and
 * applies `checkCustomRolePermissions` (catalog ⊇ subset ⊇ governance boundary).
 * See `custom-role-authz.ts` for the exact rules.
 */
@Injectable()
export class RolesService {
  // Stateless engine (no injected deps; tx + cache passed per call) — same
  // construction pattern as AuthorizationGuard.
  private readonly permissions = new PermissionService();

  /** The grantable permission catalog grouped for the FE picker. */
  catalog(): PermissionCatalogEntry[] {
    return PERMISSIONS.map((permission) => ({
      permission,
      resource: permission.split('.')[0] ?? permission,
      governance: isGovernancePermission(permission),
    }));
  }

  /**
   * Resolve the actor's implication-expanded effective permission set on the
   * org scope (the basis for the anti-escalation subset/governance check).
   */
  private async actorEffective(
    tx: TenantTx,
    actor: AccessTokenPayload,
  ): Promise<ReadonlySet<Permission>> {
    const u: AuthzUser = { id: actor.sub, orgId: actor.orgId };
    const cache = new PermissionResolutionCache();
    return this.permissions.effectivePermissions(u, { type: 'org', id: actor.orgId }, tx, cache);
  }

  /**
   * The boundary gate (R1/R2/R3 — `custom-role-authz.ts`). Throws 422 with the
   * offending permissions on any violation; returns the deduped, sorted, valid
   * permission set otherwise. Called on create + on every permission REPLACE.
   */
  private async assertPermissionsAllowed(
    tx: TenantTx,
    actor: AccessTokenPayload,
    requested: readonly string[],
  ): Promise<Permission[]> {
    const effective = await this.actorEffective(tx, actor);
    const violation = checkCustomRolePermissions(requested, effective);
    if (violation) {
      throw new UnprocessableEntityException({
        error: {
          code: violation.code,
          message: this.violationMessage(violation.code),
          details: { permissions: violation.permissions },
        },
      });
    }
    return [...new Set(requested)].map((p) => p as Permission).sort();
  }

  private violationMessage(code: string): string {
    switch (code) {
      case 'unknown_permission':
        return 'One or more permissions are not recognized.';
      case 'permission_not_held':
        return 'You cannot grant a permission you do not hold.';
      case 'governance_owner_only':
        return 'Only an Owner may include governance permissions (roles.* / org.*) in a custom role.';
      default:
        return 'Permission set rejected.';
    }
  }

  /**
   * Derive a stable, org-unique machine key from the human name. Slug + a numeric
   * suffix on collision (the `(org_id, key)` unique index is the final guard).
   */
  private async deriveUniqueKey(tx: TenantTx, orgId: string, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'role';
    const existing = await tx
      .select({ key: roles.key })
      .from(roles)
      .where(
        and(
          eq(roles.orgId, orgId),
          sql`${roles.key} = ${base} OR ${roles.key} LIKE ${base + '-%'}`,
        ),
      );
    const taken = new Set(existing.map((r) => r.key));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    // Astronomically unlikely; fall back to a random suffix.
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** List system + custom roles for the caller's org, with assignment counts. */
  async list(actor: AccessTokenPayload): Promise<RoleSummary[]> {
    return withTenant(
      actor.orgId,
      async (tx) => {
        // RLS already returns own-org custom roles + all system roles (org_id IS
        // NULL). Order: system first (canonical), then custom by name.
        const roleRows = await tx
          .select({
            id: roles.id,
            orgId: roles.orgId,
            key: roles.key,
            name: roles.name,
            description: roles.description,
            isSystem: roles.isSystem,
            createdAt: roles.createdAt,
            updatedAt: roles.updatedAt,
          })
          .from(roles);

        const roleIds = roleRows.map((r) => r.id);
        const perms = roleIds.length
          ? await tx
              .select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission })
              .from(rolePermissions)
              .where(inArray(rolePermissions.roleId, roleIds))
          : [];
        const permsByRole = new Map<string, string[]>();
        for (const p of perms) {
          const arr = permsByRole.get(p.roleId) ?? [];
          arr.push(p.permission);
          permsByRole.set(p.roleId, arr);
        }

        // Assignment counts — scope-isolated to this org by RLS on role_assignments.
        const counts = roleIds.length
          ? await tx
              .select({ roleId: roleAssignments.roleId, n: sql<number>`count(*)::int` })
              .from(roleAssignments)
              .where(inArray(roleAssignments.roleId, roleIds))
              .groupBy(roleAssignments.roleId)
          : [];
        const countByRole = new Map(counts.map((c) => [c.roleId, c.n]));

        const summaries: RoleSummary[] = roleRows.map((r) => ({
          id: r.id,
          orgId: r.orgId,
          key: r.key,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          permissions: (permsByRole.get(r.id) ?? []).sort(),
          assignmentCount: countByRole.get(r.id) ?? 0,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
        summaries.sort((a, b) => {
          if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return summaries;
      },
      { userId: actor.sub },
    );
  }

  async create(actor: AccessTokenPayload, input: CreateCustomRole): Promise<RoleSummary> {
    return withTenant(
      actor.orgId,
      async (tx) => {
        const permissions = await this.assertPermissionsAllowed(tx, actor, input.permissions);
        const key = await this.deriveUniqueKey(tx, actor.orgId, input.name);

        let role;
        try {
          // org_id is set explicitly to the actor's org; is_system stays false
          // (the CHECK constraint forbids a system flag with a non-null org, and
          // RLS WITH CHECK forbids inserting another org's row).
          [role] = await tx
            .insert(roles)
            .values({
              orgId: actor.orgId,
              key,
              name: input.name,
              description: input.description ?? null,
              isSystem: false,
            })
            .returning();
        } catch (e) {
          // Unique (org_id, key) collision under a name race → 409.
          if (e instanceof Error && /roles_org_key_unique/.test(e.message)) {
            throw new ConflictException({ error: { code: 'role_name_taken' } });
          }
          throw e;
        }
        if (!role) throw new Error('roles: insert returned no row');

        if (permissions.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(permissions.map((permission) => ({ roleId: role.id, permission })))
            .onConflictDoNothing();
        }

        await new AuditService(tx, { ip: actor.ip, userAgent: actor.userAgent }).log({
          orgId: actor.orgId,
          actorId: actor.sub,
          actorType: 'user',
          action: 'role.create',
          targetTable: 'roles',
          targetId: role.id,
          afterState: { key, name: input.name, permissions }, // no PII
          sessionId: actor.sid,
        });

        return {
          id: role.id,
          orgId: role.orgId,
          key: role.key,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          permissions: [...permissions].sort(),
          assignmentCount: 0,
          createdAt: role.createdAt,
          updatedAt: role.updatedAt,
        };
      },
      { userId: actor.sub },
    );
  }

  async update(
    actor: AccessTokenPayload,
    roleId: string,
    input: UpdateCustomRole,
  ): Promise<RoleSummary> {
    const { result, sessionsFlushed } = await withTenant(
      actor.orgId,
      async (tx) => {
        const [existing] = await tx
          .select({
            id: roles.id,
            orgId: roles.orgId,
            key: roles.key,
            isSystem: roles.isSystem,
          })
          .from(roles)
          .where(eq(roles.id, roleId))
          .limit(1);
        if (!existing) throw NOT_FOUND;
        // A system role (org_id IS NULL, is_system) is immutable via this surface.
        // RLS also blocks the UPDATE (WITH CHECK requires org_id = current org),
        // but we reject explicitly for a precise 422 rather than a 0-row update.
        if (existing.isSystem || existing.orgId === null) throw SYSTEM_IMMUTABLE;

        const beforePerms = (
          await tx
            .select({ permission: rolePermissions.permission })
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId))
        )
          .map((p) => p.permission)
          .sort();

        let newPerms: Permission[] | null = null;
        if (input.permissions !== undefined) {
          newPerms = await this.assertPermissionsAllowed(tx, actor, input.permissions);
        }

        const setClause: Record<string, unknown> = { updatedAt: new Date() };
        if (input.name !== undefined) setClause['name'] = input.name;
        if (input.description !== undefined) setClause['description'] = input.description;

        const [updated] = await tx
          .update(roles)
          .set(setClause)
          .where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)))
          .returning();
        if (!updated) throw NOT_FOUND;

        if (newPerms !== null) {
          // Replace the permission set atomically (delete-all + insert).
          await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
          if (newPerms.length > 0) {
            await tx
              .insert(rolePermissions)
              .values(newPerms.map((permission) => ({ roleId, permission })))
              .onConflictDoNothing();
          }
          // SECURITY: a permission change on a role someone HOLDS must take
          // effect immediately. The engine resolves live from role_permissions,
          // so the next access-token check already sees the new set — but kill
          // the active sessions of users holding this role so any access token
          // minted on the OLD set is invalidated within the request (parity with
          // member.role_change). Bounded to assignees of THIS role in THIS org.
          await this.revokeSessionsForRole(tx, roleId);
        }

        const finalPerms = newPerms ?? (beforePerms as Permission[]);

        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(roleAssignments)
          .where(eq(roleAssignments.roleId, roleId));

        await new AuditService(tx, { ip: actor.ip, userAgent: actor.userAgent }).log({
          orgId: actor.orgId,
          actorId: actor.sub,
          actorType: 'user',
          action: 'role.update',
          targetTable: 'roles',
          targetId: roleId,
          beforeState: { permissions: beforePerms },
          afterState: {
            name: input.name,
            permissions: newPerms ?? undefined,
          },
          sessionId: actor.sid,
        });

        const result: RoleSummary = {
          id: updated.id,
          orgId: updated.orgId,
          key: updated.key,
          name: updated.name,
          description: updated.description,
          isSystem: updated.isSystem,
          permissions: [...finalPerms].sort(),
          assignmentCount: count?.n ?? 0,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };
        return { result, sessionsFlushed: newPerms !== null };
      },
      { userId: actor.sub },
    );
    // flush AFTER commit so other workers don't re-cache stale sids.
    if (sessionsFlushed) flushSessionCache();
    return result;
  }

  async remove(actor: AccessTokenPayload, roleId: string): Promise<void> {
    await withTenant(
      actor.orgId,
      async (tx) => {
        const [existing] = await tx
          .select({ id: roles.id, orgId: roles.orgId, key: roles.key, isSystem: roles.isSystem })
          .from(roles)
          .where(eq(roles.id, roleId))
          .limit(1);
        if (!existing) throw NOT_FOUND;
        if (existing.isSystem || existing.orgId === null) throw SYSTEM_IMMUTABLE;

        // Block delete while assigned (the FK is ON DELETE RESTRICT anyway, but
        // a precise pre-check yields a clean 409 instead of a DB error).
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(roleAssignments)
          .where(eq(roleAssignments.roleId, roleId));
        if ((count?.n ?? 0) > 0) throw ROLE_IN_USE;

        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        await tx.delete(roles).where(and(eq(roles.id, roleId), eq(roles.orgId, actor.orgId)));

        await new AuditService(tx, { ip: actor.ip, userAgent: actor.userAgent }).log({
          orgId: actor.orgId,
          actorId: actor.sub,
          actorType: 'user',
          action: 'role.delete',
          targetTable: 'roles',
          targetId: roleId,
          afterState: { key: existing.key },
          sessionId: actor.sid,
        });
      },
      { userId: actor.sub },
    );
  }

  /**
   * Assign a role (system or custom) to a member at org scope. The engine then
   * enforces it on the target's next request. Anti-escalation: the actor may
   * only grant a role whose permission set ⊆ the actor's effective set, and only
   * an Owner may grant a role that carries governance (`roles.*` / `org.*`) — the same
   * boundary as minting one. For SYSTEM Owner/Admin we additionally require the
   * actor to be an Owner (tier guard, parity with member surface).
   */
  async assign(actor: AccessTokenPayload, input: AssignRole): Promise<void> {
    if (input.userId === actor.sub) {
      // No self-grant: an actor escalating their own grants is exactly the
      // primitive we forbid. (Owner/Admin already hold what they need.)
      throw new BadRequestException({ error: { code: 'cannot_assign_self' } });
    }
    await withTenant(
      actor.orgId,
      async (tx) => {
        const [role] = await tx
          .select({
            id: roles.id,
            orgId: roles.orgId,
            key: roles.key,
            isSystem: roles.isSystem,
          })
          .from(roles)
          .where(eq(roles.id, input.roleId))
          .limit(1);
        if (!role) throw NOT_FOUND;
        // A custom role must belong to THIS org (never assign another tenant's
        // custom role — RLS already hides it, but assert for a clean error).
        if (!role.isSystem && role.orgId !== actor.orgId) throw NOT_FOUND;

        // Target must be an ACTIVE member of this org (you assign roles to org
        // members, not arbitrary users). RLS already scopes `memberships` to the
        // current org; require a non-revoked row.
        const [target] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, input.userId),
              eq(memberships.orgId, actor.orgId),
              isNull(memberships.revokedAt),
            ),
          )
          .limit(1);
        if (!target) throw new NotFoundException({ error: { code: 'member_not_found' } });

        // The role's permission set — the basis for the subset/governance gate.
        const rolePerms = (
          await tx
            .select({ permission: rolePermissions.permission })
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, role.id))
        ).map((p) => p.permission);

        const effective = await this.actorEffective(tx, actor);

        // Owner/Admin SYSTEM roles: only an Owner may grant them (tier guard).
        if (role.isSystem && (role.key === 'owner' || role.key === 'admin')) {
          if (!actorIsOwner(effective)) {
            throw new ForbiddenException({ error: { code: 'owner_required_for_tier' } });
          }
        }
        // Anti-escalation for assignment: the granted role can't carry a
        // permission the actor lacks (subset). NOTE: assignment uses the
        // subset-only check — NOT the governance-Owner-only block that gates
        // MINTING — because system roles legitimately contain governance READS
        // (Viewer holds roles.read / org.settings.read) an Admin must be able to
        // assign. The Owner/Admin TIER guard above already restricts the
        // privileged tiers to Owners; the subset rule blocks everything else.
        const violation = checkRoleAssignable(rolePerms, effective);
        if (violation) {
          throw new ForbiddenException({
            error: {
              code: 'role_grant_exceeds_actor',
              message: 'You cannot grant a role that exceeds your own permissions.',
              details: { code: violation.code, permissions: violation.permissions },
            },
          });
        }

        await tx
          .insert(roleAssignments)
          .values({
            userId: input.userId,
            roleId: role.id,
            scopeType: 'org',
            scopeId: actor.orgId,
            grantedBy: actor.sub,
          })
          .onConflictDoNothing();

        await new AuditService(tx, { ip: actor.ip, userAgent: actor.userAgent }).log({
          orgId: actor.orgId,
          actorId: actor.sub,
          actorType: 'user',
          action: 'role.assign',
          targetTable: 'role_assignments',
          targetId: input.userId,
          afterState: { roleId: role.id, roleKey: role.key, scope: 'org' }, // no PII
          sessionId: actor.sid,
        });
      },
      { userId: actor.sub },
    );
  }

  /**
   * Revoke a specific (user, role) org-scope grant. Guards against stranding the
   * org: refuse to revoke the LAST org-scope Owner grant. Kills the target's
   * sessions so the lost permissions take effect immediately.
   */
  async revoke(actor: AccessTokenPayload, input: RevokeRole): Promise<void> {
    await withTenant(
      actor.orgId,
      async (tx) => {
        const [role] = await tx
          .select({ id: roles.id, key: roles.key, isSystem: roles.isSystem })
          .from(roles)
          .where(eq(roles.id, input.roleId))
          .limit(1);
        if (!role) throw NOT_FOUND;

        // assertNotLastOwner — never strand the org. If revoking an Owner grant,
        // require at least one OTHER org-scope Owner assignment to remain.
        if (role.isSystem && role.key === 'owner') {
          await this.assertNotLastOwner(tx, actor.orgId, input.userId);
        }

        const deleted = await tx
          .delete(roleAssignments)
          .where(
            and(
              eq(roleAssignments.userId, input.userId),
              eq(roleAssignments.roleId, input.roleId),
              eq(roleAssignments.scopeType, 'org'),
              eq(roleAssignments.scopeId, actor.orgId),
            ),
          )
          .returning({ id: roleAssignments.id });
        if (deleted.length === 0)
          throw new NotFoundException({ error: { code: 'assignment_not_found' } });

        // Invalidate the target's active access tokens (parity with member revoke).
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(authSessions.userId, input.userId), isNull(authSessions.revokedAt)));

        await new AuditService(tx, { ip: actor.ip, userAgent: actor.userAgent }).log({
          orgId: actor.orgId,
          actorId: actor.sub,
          actorType: 'user',
          action: 'role.revoke',
          targetTable: 'role_assignments',
          targetId: input.userId,
          afterState: {
            roleId: input.roleId,
            roleKey: role.key,
            scope: 'org',
            sessionsRevoked: true,
          },
          sessionId: actor.sid,
        });
      },
      { userId: actor.sub },
    );
    flushSessionCache();
  }

  /**
   * Refuse to leave the org with zero Owners. If `targetUserId` currently holds
   * an org-scope Owner grant, require at least one OTHER user to hold one.
   */
  private async assertNotLastOwner(
    tx: TenantTx,
    orgId: string,
    targetUserId: string,
  ): Promise<void> {
    const ownerRoleId = await this.ownerSystemRoleId(tx);
    if (!ownerRoleId) return;
    const [holdsOwner] = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.userId, targetUserId),
          eq(roleAssignments.roleId, ownerRoleId),
          eq(roleAssignments.scopeType, 'org'),
          eq(roleAssignments.scopeId, orgId),
        ),
      )
      .limit(1);
    if (!holdsOwner) return; // not an Owner → no lockout risk
    const [other] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.roleId, ownerRoleId),
          eq(roleAssignments.scopeType, 'org'),
          eq(roleAssignments.scopeId, orgId),
          sql`${roleAssignments.userId} <> ${targetUserId}`,
        ),
      );
    if ((other?.n ?? 0) < 1) throw LAST_OWNER;
  }

  private async ownerSystemRoleId(tx: TenantTx): Promise<string | null> {
    const [row] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.orgId), eq(roles.isSystem, true), eq(roles.key, 'owner')))
      .limit(1);
    return row?.id ?? null;
  }

  /** Revoke the active sessions of every user holding `roleId` in this org. */
  private async revokeSessionsForRole(tx: TenantTx, roleId: string): Promise<void> {
    const holders = await tx
      .selectDistinct({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .where(eq(roleAssignments.roleId, roleId));
    const userIds = holders.map((h) => h.userId);
    if (userIds.length === 0) return;
    await tx
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(inArray(authSessions.userId, userIds), isNull(authSessions.revokedAt)));
  }
}
