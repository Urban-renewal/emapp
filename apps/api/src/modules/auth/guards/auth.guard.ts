import { serverEnv } from '@emapp/config';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException({ error: { code: 'missing_token' } });
    }

    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload>(token, {
        secret: serverEnv.JWT_SECRET,
        algorithms: ['HS256'], // pin: reject alg:none / RS↔HS confusion
        issuer: 'emapp',
        audience: 'emapp-api',
      });
    } catch {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }

    if (payload.type !== 'access') {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }

    (req as FastifyRequest & { user: AccessTokenPayload }).user = payload;
    return true;
  }

  private extractToken(req: FastifyRequest): string | undefined {
    // Prefer cookie, fall back to Authorization header (for API clients)
    const cookie = (req.cookies as Record<string, string | undefined>)?.['access_token'];
    if (cookie) return cookie;

    const header = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) return header.slice(7);

    return undefined;
  }
}
