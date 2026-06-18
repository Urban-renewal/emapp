import { serverEnv } from '@emapp/config';
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards, UsePipes } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { NoValidation } from '../../../common/pipes/zod-validation.decorators';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

import { ProviderAuthGuard } from './provider-auth.guard';
import { ProviderAuthService, type ProviderTokenPayload } from './provider-auth.service';
import { ProviderLoginSchema, type ProviderLoginDto } from './provider-login.dto';

const SECURE = serverEnv.NODE_ENV !== 'development' && serverEnv.NODE_ENV !== 'test';
const BASE = { httpOnly: true, secure: SECURE, sameSite: 'lax' as const } as const;
const REFRESH_PATH = '/api/v1/provider/auth/refresh';

@Controller('provider/auth')
export class ProviderAuthController {
  constructor(private readonly svc: ProviderAuthService) {}

  private setCookies(res: FastifyReply, access: string, refresh: string) {
    res.setCookie('provider_access_token', access, {
      ...BASE,
      path: '/',
      maxAge: ProviderAuthService.ACCESS_TTL_SEC,
    });
    res.setCookie('provider_refresh_token', refresh, {
      ...BASE,
      path: REFRESH_PATH,
      maxAge: ProviderAuthService.REFRESH_TTL_SEC,
    });
  }

  @Throttle({ default: { limit: 5, ttl: 600000 } })
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(ProviderLoginSchema))
  async login(
    @Body() dto: ProviderLoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const ua = req.headers['user-agent']?.slice(0, 512);
    const r = await this.svc.login(dto, req.ip, ua);
    this.setCookies(res, r.accessToken, r.refreshToken);
    return { data: { ok: true } };
  }

  // S0-SEC opt-out: no client body — reads only the httpOnly refresh cookie.
  @NoValidation()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const token = (req.cookies as Record<string, string | undefined>)?.['provider_refresh_token'];
    if (!token) {
      res.status(401);
      return { error: { code: 'missing_refresh_token', message: 'No refresh token' } };
    }
    const r = await this.svc.refresh(token);
    this.setCookies(res, r.accessToken, r.refreshToken);
    return { data: { ok: true } };
  }

  // S0-SEC opt-out: no client body — acts on the authenticated session only.
  @NoValidation()
  @UseGuards(ProviderAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const pu = (req as FastifyRequest & { providerUser: ProviderTokenPayload }).providerUser;
    await this.svc.logout(pu.sub);
    res.clearCookie('provider_access_token', { ...BASE, path: '/', maxAge: 0 });
    res.clearCookie('provider_refresh_token', { ...BASE, path: REFRESH_PATH, maxAge: 0 });
    return { data: { ok: true } };
  }
}
