import { serverEnv } from '@emapp/config';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import type { ProviderTokenPayload } from './provider-auth.service';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const cookie = (req.cookies as Record<string, string | undefined>)?.['provider_access_token'];
    const header = req.headers['authorization'];
    const token = cookie ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) throw new UnauthorizedException({ error: { code: 'missing_token' } });

    let payload: ProviderTokenPayload;
    try {
      payload = this.jwt.verify<ProviderTokenPayload>(token, {
        secret: serverEnv.JWT_SECRET,
        algorithms: ['HS256'],
        issuer: 'emapp',
        audience: 'emapp-api',
      });
    } catch {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    // Tier isolation: an org-user access token (type 'access') must NOT pass
    // the provider guard, and vice-versa.
    if (payload.type !== 'provider_access' || payload.role !== 'provider_admin') {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    (req as FastifyRequest & { providerUser: ProviderTokenPayload }).providerUser = payload;
    return true;
  }
}
