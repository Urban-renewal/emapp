import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../../modules/auth/auth.service';

import { AUTHZ_ACTION, AUTHZ_RESOURCE } from './authz.decorators';
import { can, type Action, type Resource, type Role } from './policy';

const VERB_TO_ACTION: Record<string, Action> = {
  GET: 'read',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/**
 * The SINGLE D.17 role-enforcement point. Runs AFTER AuthGuard +
 * TenantGuard (so req.user is set). Reads the controller's declared
 * resource + the (verb-defaulted, optionally overridden) action and
 * consults the one POLICY table. Fail-CLOSED: missing metadata, missing
 * role, or a denied (role,resource,action) → 403 `forbidden` (D.16).
 *
 * Record-level scoping (agent→assigned, note author, self-notifications)
 * remains in the service; this guard only guarantees a coarsely-forbidden
 * role can never reach that code — eliminating the "a new slice forgot
 * requireManager → silent privilege escalation" class of bug.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const resource = Reflect.getMetadata(AUTHZ_RESOURCE, ctx.getClass()) as Resource | undefined;
    if (!resource) {
      // A domain controller without @AuthzResource is a misconfiguration,
      // not an open door. Deny.
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AccessTokenPayload }>();

    const override = Reflect.getMetadata(AUTHZ_ACTION, ctx.getHandler()) as Action | undefined;
    const action = override ?? VERB_TO_ACTION[req.method ?? ''];
    if (!action) throw new ForbiddenException({ error: { code: 'forbidden' } });

    const role = req.user?.role as Role | undefined;
    if (!role || !can(role, resource, action)) {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }
    return true;
  }
}
