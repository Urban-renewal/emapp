import {
  AuditService,
  authSessions,
  memberPermissionOverrides,
  memberships,
  roleAssignments,
  roles,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { MemberPermissionOverride, SetMemberOverride } from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import {
  PermissionResolutionCache,
  PermissionService,
  type Scope,
} from '../../common/authz/permission.service';
import { isPermission, type Permission } from '../../common/authz/permissions';
import type { AccessTokenPayload } from '../auth/auth.service';
import { flushSessionCache } from '../auth/session-validity';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const SELF = new BadRequestException({ error: { code: 'cannot_modify_self' } });
const UNKNOWN_PERMISSION = new BadRequestException({ error: { code: 'unknown_permission' } });
// A GRANT whose permission the grantor does not themselves hold (anti-escalation).
const ESCALATION = new ForbiddenException({ error: { code: 'override_escalation' } });
// Owner-tier permission (org.*/roles.*) granted by a non-Owner.
const OWNER_ONLY = new ForbiddenException({ error: { code: 'override_owner_tier_only' } });
// A DENY that would strip an Owner's governance — would brick the org.
const LAST_OWNER = new BadRequestException({ error: { code: 'cannot_strip_last_owner' } });

/** Owner-tier prefixes — only an Owner may GRANT these via an override. */
const OWNER_TIER_PREFIXES = ['org.', 'roles.'] as const;

function isOwnerTier(permission: Permission): boolean {
  return OWNER_TIER_PREFIXES.some((p) => permission.startsWith(p));
}

/**
 * P2 Phase 2 — per-user permission OVERRIDES administration (Owner/Admin only;
 * the route is `roles.manage`-gated by the controller).
 *
 * The override layer lets an Owner/Admin GRANT or DENY a single catalog
 * permission to a single member, on org or project scope, on top of their
 * role-derived set. The engine resolves `final = (role ∪ GRANT) − DENY` with
 * DENY winning (`permission.service.ts`).
 *
 * SECURITY (the reviewer's attack surface):
 *  - GRANT anti-escalation: every GRANTed permission must be ⊆ the GRANTOR's
 *    OWN effective perms on the SAME scope (you cannot grant what you lack), and
 *    an Owner-tier permission (`org.*` / `roles.*`) may be GRANTed ONLY by an
 *    Owner. Mirrors `PermissionService.canAssignRole` [G2].
 *  - DENY has no escalation risk (it only removes), but it is still
 *    `roles.manage`-gated, audited, and MUST NOT brick governance: a DENY of an
 *    `org.*` permission on a member who is the SOLE Owner is refused
 *    (`cannot_strip_last_owner`) — otherwise the org could be left with no one
 *    able to transfer ownership / manage roles.
 *  - Tenant-scoped: the target membership must be live in the actor's org (RLS
 *    + an explicit membership lookup). No self-modification (lockout guard).
 *  - On any change the target's auth sessions are killed (same posture as a
 *    role change) so a tightened/loosened permission takes effect immediately,
 *    not after the ≤15-min access-token TTL.
 */
@Injectable()
export class MemberOverridesService {
  private readonly engine = new PermissionService();

  /**
   * List a member's overrides (read surface for the FE override panel). The
   * member must be in the actor's org. Sorted (scope, permission) for a stable
   * payload.
   */
  async list(actor: AccessTokenPayload, targetUserId: string): Promise<MemberPermissionOverride[]> {
    return withTenant(
      actor.orgId,
      async (tx) => {
        await this.assertTargetInOrg(tx, actor.orgId, targetUserId);
        const rows = await tx
          .select()
          .from(memberPermissionOverrides)
          .where(eq(memberPermissionOverrides.userId, targetUserId))
          .orderBy(
            asc(memberPermissionOverrides.scopeType),
            asc(memberPermissionOverrides.permission),
          );
        return rows.map(toWire);
      },
      { userId: actor.sub },
    );
  }

  /**
   * Set (upsert) ONE override. Enforces the anti-escalation + last-Owner guards,
   * audits, and kills the target's sessions.
   */
  async set(
    actor: AccessTokenPayload,
    targetUserId: string,
    input: SetMemberOverride,
  ): Promise<MemberPermissionOverride> {
    if (targetUserId === actor.sub) throw SELF; // no self-override (lockout guard)

    // Validate the permission against the CODE catalog — fail-closed on an
    // unknown string (never persist a typo'd / future permission).
    if (!isPermission(input.permission)) throw UNKNOWN_PERMISSION;
    const permission: Permission = input.permission;
    const scope = this.resolveScope(actor.orgId, input);

    const result = await withTenant(
      actor.orgId,
      async (tx) => {
        await this.assertTargetInOrg(tx, actor.orgId, targetUserId);

        const cache = new PermissionResolutionCache();
        const actorPerms = await this.engine.effectivePermissions(
          { id: actor.sub, orgId: actor.orgId },
          scope,
          tx,
          cache,
        );
        const actorIsOwner = isOwner(actorPerms);

        if (input.effect === 'grant') {
          // Anti-escalation: cannot grant a permission you don't hold.
          if (!actorPerms.has(permission)) throw ESCALATION;
          // Owner-tier permissions may be granted ONLY by an Owner.
          if (isOwnerTier(permission) && !actorIsOwner) throw OWNER_ONLY;
        } else {
          // DENY: would this strip governance from the sole Owner? Refuse a DENY
          // of an org.* permission on a member who is the last usable Owner.
          if (permission.startsWith('org.')) {
            await this.assertNotStrandingLastOwner(tx, actor.orgId, targetUserId, scope);
          }
        }

        // Upsert: at most one row per (user, permission, scope). Re-setting flips
        // grant↔deny (ON CONFLICT updates the effect + created_by/at).
        const [row] = await tx
          .insert(memberPermissionOverrides)
          .values({
            userId: targetUserId,
            permission,
            effect: input.effect,
            scopeType: scope.type,
            scopeId: scope.id,
            createdBy: actor.sub,
          })
          .onConflictDoUpdate({
            target: [
              memberPermissionOverrides.userId,
              memberPermissionOverrides.permission,
              memberPermissionOverrides.scopeType,
              memberPermissionOverrides.scopeId,
            ],
            set: { effect: input.effect, createdBy: actor.sub, createdAt: new Date() },
          })
          .returning();
        if (!row) throw NOT_FOUND;

        await this.killSessionsAndAudit(tx, actor, targetUserId, {
          action: 'member.override_set',
          afterState: {
            permission,
            effect: input.effect,
            scope: scope.type,
          },
        });
        return toWire(row);
      },
      { userId: actor.sub },
    );

    flushSessionCache();
    return result;
  }

  /**
   * Clear ONE override by its (permission, scope) key. Clearing an override
   * restores the member's role-derived value for that permission. No escalation
   * risk (it only removes a layered override), but still audited + sessions
   * killed (the effective set changes). 404 if no such override exists.
   */
  async clear(
    actor: AccessTokenPayload,
    targetUserId: string,
    input: { permission: string; scopeType: 'org' | 'project'; scopeId?: string },
  ): Promise<void> {
    if (targetUserId === actor.sub) throw SELF;
    if (!isPermission(input.permission)) throw UNKNOWN_PERMISSION;
    const permission: Permission = input.permission;
    const scope = this.resolveScope(actor.orgId, input);

    await withTenant(
      actor.orgId,
      async (tx) => {
        await this.assertTargetInOrg(tx, actor.orgId, targetUserId);
        const deleted = await tx
          .delete(memberPermissionOverrides)
          .where(
            and(
              eq(memberPermissionOverrides.userId, targetUserId),
              eq(memberPermissionOverrides.permission, permission),
              eq(memberPermissionOverrides.scopeType, scope.type),
              eq(memberPermissionOverrides.scopeId, scope.id),
            ),
          )
          .returning({ id: memberPermissionOverrides.id });
        if (deleted.length === 0) throw NOT_FOUND;

        await this.killSessionsAndAudit(tx, actor, targetUserId, {
          action: 'member.override_clear',
          afterState: { permission, scope: scope.type },
        });
      },
      { userId: actor.sub },
    );

    flushSessionCache();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** org scope = the actor's org; project scope = the supplied project id. */
  private resolveScope(
    orgId: string,
    input: { scopeType: 'org' | 'project'; scopeId?: string },
  ): Scope {
    if (input.scopeType === 'project') {
      // The DTO refine guarantees scopeId is present for project scope.
      return { type: 'project', id: input.scopeId as string };
    }
    return { type: 'org', id: orgId };
  }

  /**
   * The target must be a LIVE (non-revoked) member of the actor's org. RLS
   * already isolates the override rows to the org; this is the explicit,
   * defense-in-depth membership gate (and the source of the 404 when the target
   * isn't a member). Returns nothing; throws NOT_FOUND otherwise.
   */
  private async assertTargetInOrg(
    tx: TenantTx,
    orgId: string,
    targetUserId: string,
  ): Promise<void> {
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, targetUserId),
          eq(memberships.orgId, orgId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    if (!m) throw NOT_FOUND;
  }

  /**
   * Governance-availability guard: refuse a DENY of an `org.*` permission when
   * the target is the SOLE Owner of the org — otherwise no one could transfer
   * ownership / manage the org. "Owner" is detected via the engine: a member
   * whose effective set holds BOTH `org.transfer_ownership` and `org.delete`
   * (the Owner-exclusive pair, same test as `canAssignRole`). If the target is
   * an Owner and there is no OTHER usable Owner, the DENY is refused.
   *
   * We scope the Owner check at ORG scope (governance is org-level) regardless
   * of the override's scope — an org.* permission is only meaningful org-wide.
   */
  private async assertNotStrandingLastOwner(
    tx: TenantTx,
    orgId: string,
    targetUserId: string,
    _scope: Scope,
  ): Promise<void> {
    const orgScope: Scope = { type: 'org', id: orgId };

    // Is the TARGET an Owner? (Resolve their effective set, fresh cache.)
    const targetPerms = await this.engine.effectivePermissions(
      { id: targetUserId, orgId },
      orgScope,
      tx,
      new PermissionResolutionCache(),
    );
    if (!isOwner(targetPerms)) return; // not an Owner → DENY can't brick governance

    // Find every OTHER live member who holds an Owner-key role assignment at org
    // scope, and confirm at least one of them resolves as a usable Owner. We
    // gate on the Owner system role assignment to bound the candidate set, then
    // re-resolve through the engine (an override could itself have stripped one).
    const ownerRoleIds = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.orgId), eq(roles.isSystem, true), eq(roles.key, 'owner')));
    if (ownerRoleIds.length === 0) return; // no Owner role seeded (shouldn't happen)

    const otherOwnerAssignments = await tx
      .selectDistinct({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(
        memberships,
        and(eq(memberships.userId, roleAssignments.userId), eq(memberships.orgId, orgId)),
      )
      .where(
        and(
          eq(roleAssignments.scopeType, 'org'),
          eq(roleAssignments.scopeId, orgId),
          inArray(
            roleAssignments.roleId,
            ownerRoleIds.map((r) => r.id),
          ),
          isNull(memberships.revokedAt),
        ),
      );

    for (const candidate of otherOwnerAssignments) {
      if (candidate.userId === targetUserId) continue;
      const perms = await this.engine.effectivePermissions(
        { id: candidate.userId, orgId },
        orgScope,
        tx,
        new PermissionResolutionCache(),
      );
      if (isOwner(perms)) return; // another usable Owner remains → DENY is safe
    }
    throw LAST_OWNER;
  }

  /**
   * Kill the target's active auth sessions (so the permission change is
   * immediate, not after the access-token TTL) + write the audit row. Mirrors
   * the role-change posture in MembersService. NO PII in the audit afterState.
   */
  private async killSessionsAndAudit(
    tx: TenantTx,
    actor: AccessTokenPayload,
    targetUserId: string,
    entry: { action: string; afterState: Record<string, unknown> },
  ): Promise<void> {
    await tx
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, targetUserId), isNull(authSessions.revokedAt)));

    await new AuditService(tx, { ip: actor.ip, userAgent: actor.userAgent }).log({
      orgId: actor.orgId,
      actorId: actor.sub,
      actorType: 'user',
      action: entry.action,
      targetTable: 'member_permission_overrides',
      targetId: targetUserId,
      afterState: { ...entry.afterState, sessionsRevoked: true },
      sessionId: actor.sid,
    });
  }
}

/** Owner = holds the Owner-exclusive pair (transfer_ownership + delete). */
function isOwner(perms: ReadonlySet<Permission>): boolean {
  return perms.has('org.transfer_ownership') && perms.has('org.delete');
}

function toWire(row: typeof memberPermissionOverrides.$inferSelect): MemberPermissionOverride {
  return {
    id: row.id,
    userId: row.userId,
    permission: row.permission,
    effect: row.effect === 'deny' ? 'deny' : 'grant',
    scopeType: row.scopeType === 'project' ? 'project' : 'org',
    scopeId: row.scopeId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
