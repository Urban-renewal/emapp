import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../auth.service';

/**
 * Runs after AuthGuard. Copies orgId from JWT claims into request metadata
 * so downstream handlers can call withTenant(req.orgId, ...).
 *
 * Audit H-6 fix (2026-05-27 manager-be-errors audit): previously a NO-OP
 * if `req.user.orgId` was missing — flowed into `withTenant(undefined,
 * ...)` which surfaces as a pg `invalid_input` 500. Now we fail-closed:
 * a JWT without `orgId` (pre-org-selection state, a corrupt token, or a
 * future tier mix-up) returns 401 with a stable `missing_org_context`
 * code so the FE can render an actionable "re-select your organization"
 * banner instead of a generic 500.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AccessTokenPayload; orgId?: string }>();
    if (!req.user?.orgId) {
      throw new UnauthorizedException({
        error: { code: 'missing_org_context' },
      });
    }
    req.orgId = req.user.orgId;
    return true;
  }
}
