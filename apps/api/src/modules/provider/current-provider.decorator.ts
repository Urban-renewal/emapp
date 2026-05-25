/**
 * D.37 / Phase 6.5 — `@CurrentProvider()` param decorator.
 *
 * Mirrors `@CurrentUser()` for the Provider tier (D.29 tier isolation).
 * ProviderAuthGuard puts the verified `ProviderTokenPayload` on
 * `req.providerUser`; this decorator extracts it + enriches with IP /
 * User-Agent for the audit trail (ISO 27001 A.12.4).
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { ProviderTokenPayload } from '../auth/provider/provider-auth.service';

export interface ProviderPrincipal extends ProviderTokenPayload {
  ip?: string;
  userAgent?: string;
}

export const CurrentProvider = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ProviderPrincipal => {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { providerUser: ProviderTokenPayload }>();
    const ua = req.headers['user-agent'];
    return {
      ...req.providerUser,
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : undefined,
    };
  },
);
