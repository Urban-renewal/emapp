import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../auth.service';

// Returns the JWT-verified principal ENRICHED with request-context
// (source IP + User-Agent) for the audit trail (ISO 27001 A.12.4). ip is
// taken from Fastify's `request.ip` which is trustProxy-aware (set in
// main.ts) so it is the real client IP behind Railway/Cloudflare, not the
// proxy. These fields are NOT token claims and are never signed/verified.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user: AccessTokenPayload }>();
    const ua = req.headers['user-agent'];
    return {
      ...req.user,
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : undefined,
    };
  },
);
