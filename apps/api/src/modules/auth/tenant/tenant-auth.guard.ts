import { serverEnv } from '@emapp/config';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

export interface TenantTokenPayload {
  sub: string; // owner id — own record only (D.17/D.20)
  orgId: string;
  role: 'tenant';
  type: 'tenant_access';
}

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
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
        audience: 'emapp-api',
      });
    } catch {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    // Tier isolation: only a tenant token passes; org/provider tokens
    // (type 'access' / 'provider_access') are rejected, and vice-versa.
    if (payload.type !== 'tenant_access' || payload.role !== 'tenant') {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant = payload;
    return true;
  }
}
