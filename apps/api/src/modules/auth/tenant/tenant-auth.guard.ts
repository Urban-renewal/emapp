import { serverEnv } from '@emapp/config';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import { isTenantSessionActive } from '../session-validity';

export interface TenantTokenPayload {
  sub: string; // owner id — own record only (D.17/D.20)
  orgId: string;
  role: 'tenant';
  type: 'tenant_access';
  // Wave 4 M-1: refresh-chain session id. Present on tokens minted after
  // migration 0038 lands. Legacy tokens without `sid` are rejected (this
  // is acceptable — TTL is 10 min so any in-flight token expires fast).
  sid: string;
}

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const cookie = (req.cookies as Record<string, string | undefined>)?.['tenant_access_token'];
    const header = req.headers['authorization'];
    const token = cookie ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw new UnauthorizedException({ error: { code: 'missing_token' } });

    let payload: TenantTokenPayload;
    try {
      payload = this.jwt.verify<TenantTokenPayload>(token, {
        secret: serverEnv.JWT_SECRET,
        algorithms: ['HS256'],
        issuer: 'emapp',
        // Tier-isolated audience (D.29): MUST match tenant/otp.service
        // JWT_AUD. Rejects org/provider tokens structurally.
        audience: 'emapp-tenant',
      });
    } catch {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    // Tier isolation: only a tenant token passes; org/provider tokens
    // (type 'access' / 'provider_access') are rejected, and vice-versa.
    if (payload.type !== 'tenant_access' || payload.role !== 'tenant') {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    // Wave 4 M-1 — sid is mandatory. Legacy tokens (pre-0038) lack it
    // → rejected. TTL is now 10 min so legacy tokens drain fast.
    if (!payload.sid) {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    // Revocation gate (closes the 10-min stateless-JWT hole): cached
    // ≤15s in-process, so amortised cost ≈ 0. On portal/logout the
    // service calls flushSessionCache() → revoke is immediate.
    const active = await isTenantSessionActive(payload.sid);
    if (!active) {
      throw new UnauthorizedException({ error: { code: 'session_revoked' } });
    }
    (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant = payload;
    return true;
  }
}
