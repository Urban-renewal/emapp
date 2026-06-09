/**
 * Enterprise IAM — the enforcement ENGINE (IAM-DESIGN §5).
 *
 * `PermissionService.can(user, permission, scope)` is the single source of an
 * authz decision (§5): it resolves the user's `role_assignments` whose scope
 * COVERS the target (org-scope ⊇ project, §7), unions their roles'
 * `role_permissions`, expands the implication closure (§2 / `permissions.ts`),
 * and tests membership. Default-deny: no covering assignment ⇒ false (§7).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * LIVE — the single source of authorization (since slice 5a). `AuthorizationGuard`
 * calls `can()` for every `@RequirePermission` handler, resolving from
 * `role_assignments ⋈ role_permissions`. `policy.ts` is NO LONGER the request-path
 * enforcer; it is retained ONLY as the shadow-equivalence oracle
 * (`policy-equivalence.spec.ts` proves this engine ≡ the legacy matrix for every
 * role×permission). Residual `user.role` reads in services are intentional
 * RECORD-level scoping (agent→assigned-project, authorship, capability fine-gates),
 * NOT coarse authorization. See docs/DECISION-permissions-consolidation.md.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Design decisions (also documented in the PR body):
 *
 *  1. CACHE STRATEGY (§5 / G5 — ≤3 round-trips, NOT in the JWT). Resolution is
 *     per-request, ONCE. The caller threads a `PermissionResolutionCache`
 *     (one per request, created by the future guard) plus the request's
 *     existing `tx` (the `withTenant` handle). The FIRST `can()` of a request
 *     runs ONE query (assignments→role_permissions, user-filtered, RLS-scoped);
 *     every subsequent `can()` / `effectivePermissions()` on the SAME user hits
 *     the in-memory cache — zero extra round-trips. Resolution is NOT in the
 *     token, so revocation is immediate (matches the contractor live-read
 *     pattern). The cache is keyed by `userId` and never escapes the request.
 *
 *  2. QUERY SHAPE. One join: `role_assignments ⋈ role_permissions` filtered to
 *     the user, returning `(scopeType, scopeId, permission)` rows. RLS already
 *     scopes the rows to the current org (migration 0043), so no org predicate
 *     is needed in the engine. Scope COVERAGE (§7) and the implication closure
 *     are computed in memory from those rows — never per-check SQL.
 *
 *  3. IMPLICATION EXPANSION (§2 / G3). After unioning the granted permissions
 *     for the covering scopes, we expand the transitive closure over
 *     `PERMISSION_IMPLICATIONS` (`permissions.ts`): holding a child adds its
 *     parents (e.g. `owners.reveal_pii ⇒ owners.read`). The closure is computed
 *     once per resolved scope-set; you can never hold a child without its
 *     parent.
 */
import { roleAssignments, rolePermissions, type TenantTx } from '@emapp/db';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { PERMISSION_IMPLICATIONS, PERMISSION_SET, type Permission } from './permissions';
import { SYSTEM_ROLE_BY_KEY, type SystemRoleKey } from './system-roles';

/**
 * The minimal actor the engine resolves against. Derived from the request
 * (`AccessTokenPayload.sub` → `id`, `.orgId`). NOTE: the engine deliberately
 * does NOT read `role` off the token — the source of truth is the user's
 * `role_assignments` in the DB (§5).
 */
export interface AuthzUser {
  /** The user's id (`AccessTokenPayload.sub`). */
  id: string;
  /** The org context the request runs in (`AccessTokenPayload.orgId`). */
  orgId: string;
}

/**
 * The scope a permission check targets (§7). `org` covers every project in the
 * org; `project` is the subset. `id` = org_id for `org`, project_id for
 * `project`.
 */
export type Scope = { type: 'org'; id: string } | { type: 'project'; id: string };

/** A single resolved assignment row: a covering scope + a granted permission. */
interface ResolvedRow {
  scopeType: 'org' | 'project';
  scopeId: string;
  permission: string;
}

/**
 * Per-request resolution cache (§5 / G5). One instance per request (created by
 * the future guard); threaded into every `can()` call so resolution runs ONCE.
 * Keyed by `userId`. Never shared across requests, never persisted.
 *
 * We cache the in-flight PROMISE, not just the settled rows — so N concurrent
 * `can()` calls on the same user (e.g. a `Promise.all` of checks) collapse to a
 * single resolve query (the round-trip floor, G5) instead of racing the cache.
 */
export class PermissionResolutionCache {
  private readonly byUser = new Map<string, Promise<ResolvedRow[]>>();

  get(userId: string): Promise<ResolvedRow[]> | undefined {
    return this.byUser.get(userId);
  }

  set(userId: string, rows: Promise<ResolvedRow[]>): void {
    this.byUser.set(userId, rows);
  }
}

@Injectable()
export class PermissionService {
  /**
   * Does `user` hold `permission` on `scope`? The single authz decision (§5).
   *
   * Default-deny: an unknown permission, or no assignment whose scope covers
   * the target, ⇒ `false`.
   *
   * @param tx    the request's `withTenant` handle (RLS-scoped to the org).
   * @param cache the per-request resolution cache (G5 — resolve once).
   */
  async can(
    user: AuthzUser,
    permission: Permission,
    scope: Scope,
    tx: TenantTx,
    cache: PermissionResolutionCache,
  ): Promise<boolean> {
    // Unknown permission ⇒ deny (fail-closed; never a typo'd open door).
    if (!PERMISSION_SET.has(permission)) return false;
    const effective = await this.effectivePermissions(user, scope, tx, cache);
    return effective.has(permission);
  }

  /**
   * The user's EXACT effective permission-set on `scope` (used later by `/me`,
   * §8): union of all covering assignments' permissions, with the implication
   * closure expanded. Default-deny ⇒ empty set when nothing covers the scope.
   *
   * Resolution (§7): an assignment COVERS the target iff
   *   - it is `org`-scoped (covers every project + the org itself), OR
   *   - it is `project`-scoped on EXACTLY the target project.
   */
  async effectivePermissions(
    user: AuthzUser,
    scope: Scope,
    tx: TenantTx,
    cache: PermissionResolutionCache,
  ): Promise<ReadonlySet<Permission>> {
    const rows = await this.getRows(user, tx, cache);

    const granted = new Set<Permission>();
    for (const row of rows) {
      if (!this.scopeCovers(row, scope)) continue;
      // The DB column is free text; only catalog strings are real permissions.
      if (PERMISSION_SET.has(row.permission as Permission)) {
        granted.add(row.permission as Permission);
      }
    }

    return this.expandImplications(granted);
  }

  /**
   * [G2] Can `assigner` grant `roleKey` on `scope`? True iff:
   *   - the role's permission-set ⊆ the assigner's effective permissions on
   *     that scope (no granting a permission you lack — no self-escalation), AND
   *   - only an Owner may grant Owner or Admin.
   *
   * The role's permission-set is the system-role definition (`system-roles.ts`)
   * — the same source the seed mirrors. We compare against the assigner's
   * IMPLICATION-EXPANDED effective set so an assigner who holds `reveal_pii`
   * (⇒ `owners.read`) can grant a role that needs `owners.read`.
   */
  async canAssignRole(
    assigner: AuthzUser,
    roleKey: SystemRoleKey,
    scope: Scope,
    tx: TenantTx,
    cache: PermissionResolutionCache,
  ): Promise<boolean> {
    const roleDef = SYSTEM_ROLE_BY_KEY.get(roleKey);
    if (!roleDef) return false;

    const assignerPerms = await this.effectivePermissions(assigner, scope, tx, cache);

    // Owner/Admin are privileged tiers: only an Owner may grant them. We test
    // the Owner-exclusive permissions (`org.transfer_ownership` + `org.delete`)
    // — only the Owner role holds them, so this is a precise Owner check that
    // does not depend on role-name introspection.
    if (roleKey === 'owner' || roleKey === 'admin') {
      const assignerIsOwner =
        assignerPerms.has('org.transfer_ownership') && assignerPerms.has('org.delete');
      if (!assignerIsOwner) return false;
    }

    // No self-escalation: every permission the granted role would hold must be
    // one the assigner ALREADY holds on this scope.
    for (const perm of roleDef.permissions) {
      if (!assignerPerms.has(perm)) return false;
    }
    return true;
  }

  /**
   * Cache-aware accessor: returns the memoized resolution promise for the user,
   * or kicks off ONE `resolveAssignments` (the single DB fetch) and memoizes its
   * promise. Storing the in-flight PROMISE means N concurrent checks collapse to
   * a single `resolveAssignments` call — `resolveAssignments` is invoked exactly
   * once per request per user (G5; asserted by the perf spy on it).
   */
  private getRows(
    user: AuthzUser,
    tx: TenantTx,
    cache: PermissionResolutionCache,
  ): Promise<ResolvedRow[]> {
    const cached = cache.get(user.id);
    if (cached) return cached;
    const fetched = this.resolveAssignments(user, tx);
    cache.set(user.id, fetched);
    return fetched;
  }

  /**
   * The single DB fetch: the user's assignment rows. ONE query (assignments ⋈
   * role_permissions, user-filtered). RLS scopes the rows to the current org
   * (migration 0043), so the engine adds no org predicate. Returns ALL
   * covering-candidate rows (org + project scoped); scope coverage is applied
   * in memory per check.
   *
   * `protected` (no cache arg) so the perf test can spy on it to assert it is
   * called exactly once per request per user (≤1 resolve query).
   */
  protected async resolveAssignments(user: AuthzUser, tx: TenantTx): Promise<ResolvedRow[]> {
    const raw = await tx
      .select({
        scopeType: roleAssignments.scopeType,
        scopeId: roleAssignments.scopeId,
        permission: rolePermissions.permission,
      })
      .from(roleAssignments)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roleAssignments.roleId))
      // Time-boxed grants: an assignment past its expiry must NOT resolve as live
      // (silent privilege-retention otherwise). NULL expiry = never expires.
      .where(
        and(
          eq(roleAssignments.userId, user.id),
          or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
        ),
      );

    return raw.map((r) => ({
      // scope_type is a CHECK-constrained text column ∈ {'org','project'}.
      scopeType: r.scopeType === 'project' ? 'project' : 'org',
      scopeId: r.scopeId,
      permission: r.permission,
    }));
  }

  /**
   * Scope coverage (§7): does this assignment row cover the target scope?
   *   - org-scoped row ⊇ everything in that org (org target + any project).
   *   - project-scoped row covers ONLY the exact target project. It does NOT
   *     cover the org scope, and does NOT cover another project.
   *
   * NOTE: we do not re-check the org id here — RLS already guarantees every
   * resolved row belongs to the request's org (org-scope rows match the org,
   * project-scope rows belong to a project in the org). So an org-scoped row
   * covers any in-org target; a project row matches by project id only.
   */
  private scopeCovers(row: ResolvedRow, target: Scope): boolean {
    if (row.scopeType === 'org') return true;
    // project-scoped row: covers only an identical project target.
    return target.type === 'project' && row.scopeId === target.id;
  }

  /**
   * Expand the implication closure (§2 / G3). For every held permission, add
   * its declared parents transitively (`PERMISSION_IMPLICATIONS`). Idempotent
   * fixpoint — you can never hold a child without its parents.
   */
  private expandImplications(granted: Set<Permission>): ReadonlySet<Permission> {
    const out = new Set<Permission>(granted);
    const stack = [...granted];
    while (stack.length > 0) {
      const perm = stack.pop() as Permission;
      const parents = PERMISSION_IMPLICATIONS.get(perm);
      if (!parents) continue;
      for (const parent of parents) {
        if (!out.has(parent)) {
          out.add(parent);
          stack.push(parent);
        }
      }
    }
    return out;
  }
}
