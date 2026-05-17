import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../auth.service';

/**
 * Runs after AuthGuard. Copies orgId from JWT claims into request metadata
 * so downstream handlers can call withTenant(req.orgId, ...).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AccessTokenPayload; orgId?: string }>();
    if (req.user?.orgId) {
      req.orgId = req.user.orgId;
    }
    return true;
  }
}
