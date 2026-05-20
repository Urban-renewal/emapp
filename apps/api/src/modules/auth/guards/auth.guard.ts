import { serverEnv } from '@emapp/config';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import type { AccessTokenPayload } from '../auth.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { isOrgSessionActive } from '../session-validity';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
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
    } catch (e) {
      // Audit-pass IV (G2 / docs/09 §2.1 + docs/10 §2): distinguish a
      // mere TTL expiry (FE auto-refreshes silently via /auth/refresh)
      // from a structurally invalid / forged / wrong-tier token (FE
      // clears state, /login). Same 401 — different discriminator code.
      // The check is by error class name so no new import is needed.
      const isExpired = e instanceof Error && e.name === 'TokenExpiredError';
      throw new UnauthorizedException({
        error: { code: isExpired ? 'token_expired' : 'invalid_token' },
      });
    }

    if (payload.type !== 'access') {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }

    // Closes the stateless-JWT revocation hole: a logged-out / revoked /
    // reuse-purged session must stop authenticating immediately, not after
    // the access TTL. Memoised in-process (≈0 cost) — not a per-request DB.
    if (!(await isOrgSessionActive(payload.sid))) {
      throw new UnauthorizedException({ error: { code: 'session_revoked' } });
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
