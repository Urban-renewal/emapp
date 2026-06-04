import { withTenant } from '@emapp/db';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../../modules/auth/auth.service';

import { AUTHZ_PERMISSION, AUTHZ_TENANT_ONLY } from './authz.decorators';
import { PermissionResolutionCache, PermissionService, type AuthzUser } from './permission.service';
import type { Permission } from './permissions';

/**
 * SLICE 5a — the SINGLE authorization point, now ENGINE-BACKED.
 *
 * Runs AFTER AuthGuard + TenantGuard (so `req.user` is set + the org is
 * resolved). Reads the handler's `@RequirePermission('<permission>')` and asks
 * the live `PermissionService` engine: does this user hold that permission on
 * the request's ORG scope? — the same decision the slice-3 shadow-equivalence
 * proof certifies cell-for-cell against the legacy `policy.ts`. `policy.ts` is
 * no longer consulted at request time (it stays as the equivalence oracle,
 * deleted in slice 6).
 *
 * COARSE vs RECORD scope (unchanged contract). This guard is the COARSE
 * org-scope permission gate the legacy role-matrix guard used to be: it answers
 * "may this role/permission touch this resource AT ALL", at org scope — exactly
 * what `policy.can(role, resource, action)` answered. RECORD-level scoping
 * (agent → assigned project; note author; self-scoped notifications) is
 * UNCHANGED and still enforced in the service, now expressed as the assignment
 * scope (§5/§7). An agent who coarsely holds `buildings.update` here still hits
 * `requireAgentCapability` + the assigned-project check in the service.
 *
 * Fail-CLOSED. A handler with NEITHER `@RequirePermission` NOR `@TenantScoped`
 * → 403 (a route added without an authz declaration is a misconfiguration, not
 * an open door). Missing `req.user` / missing org → 403.
 *
 * PERF / TX (G5; a prior reviewer flagged this for here). The guard opens ONE
 * short `withTenant(orgId)` and a FRESH `PermissionResolutionCache`, so the
 * decision costs exactly ONE resolve query (assignments ⋈ role_permissions,
 * RLS-scoped to this org). The cache is keyed by userId and never escapes the
 * request — one org / one tx / one cache per request, no cross-request bleed.
 * `@TenantScoped` handlers (the `NO_ENGINE_EQUIVALENT` self/RLS-scoped surfaces)
 * short-circuit BEFORE any query — they cost zero round-trips.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  // Stateless engine. The guard is constructed zero-DI (`new AuthorizationGuard()`
  // in every controller's @UseGuards), so it instantiates the service itself —
  // PermissionService has no injected dependencies (it takes the tx + cache per
  // call). One instance per controller; the engine holds no per-request state.
  private readonly permissions = new PermissionService();

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handler = ctx.getHandler();
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AccessTokenPayload }>();
    const user = req.user;

    // `@TenantScoped` — authorized by tenant membership only (a documented
    // NO_ENGINE_EQUIVALENT surface: shares list/perms-edit, notifications self
    // mark-read). AuthGuard + TenantGuard already proved an authenticated org
    // member; RLS + service self-scoping govern the rows. No engine query.
    if (Reflect.getMetadata(AUTHZ_TENANT_ONLY, handler) === true) {
      if (!user?.sub || !user.orgId) {
        throw new ForbiddenException({ error: { code: 'forbidden' } });
      }
      return true;
    }

    const permission = Reflect.getMetadata(AUTHZ_PERMISSION, handler) as Permission | undefined;
    if (!permission) {
      // A domain route with neither @RequirePermission nor @TenantScoped is a
      // misconfiguration, not an open door. Deny.
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }

    if (!user?.sub || !user.orgId) {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }

    const actor: AuthzUser = { id: user.sub, orgId: user.orgId };
    const allowed = await withTenant(user.orgId, async (tx) => {
      const cache = new PermissionResolutionCache();
      return this.permissions.can(actor, permission, { type: 'org', id: user.orgId }, tx, cache);
    });

    if (!allowed) throw new ForbiddenException({ error: { code: 'forbidden' } });
    return true;
  }
}
