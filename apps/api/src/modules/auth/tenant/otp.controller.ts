import { serverEnv } from '@emapp/config';
import { OtpRequestSchema, OtpVerifySchema } from '@emapp/shared-types';
import type { OtpRequestDto, OtpVerifyDto } from '@emapp/shared-types';
import { Body, Controller, HttpCode, Post, Req, Res, UsePipes } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

import { OtpService } from './otp.service';

// Truncate UA to a sane length for audit_log (matches the org-side
// `auth.service.ua()` pattern — keeps the row small + bounded).
const uaOf = (req: FastifyRequest): string | undefined => {
  const ua = req.headers['user-agent'];
  if (typeof ua !== 'string') return undefined;
  return ua.slice(0, 512);
};

const SECURE = serverEnv.NODE_ENV !== 'development' && serverEnv.NODE_ENV !== 'test';

@Controller('auth/otp')
export class OtpController {
  constructor(private readonly otp: OtpService) {}

  // Always generic 200 — never reveals whether the phone is a known owner
  // (anti-enumeration). Service also enforces 3/15min/phone; this is the
  // per-IP volumetric brake.
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('request')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(OtpRequestSchema))
  async request(@Body() dto: OtpRequestDto, @Req() req: FastifyRequest) {
    // F2: optional org_slug disambiguates multi-org phones — see D.30.
    // G1a: pass ip+UA for audit_log of the OTP-send event — see D.31.
    await this.otp.request(dto.phone, dto.org_slug, { ip: req.ip, userAgent: uaOf(req) });
    return { data: { ok: true } };
  }

  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('verify')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(OtpVerifySchema))
  async verify(
    @Body() dto: OtpVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    // G1a: pass ip+UA for audit_log of the verify event — see D.31.
    const r = await this.otp.verify(dto.phone, dto.code, { ip: req.ip, userAgent: uaOf(req) });
    res.setCookie('tenant_access_token', r.accessToken, {
      httpOnly: true,
      secure: SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: OtpService.ACCESS_TTL_SEC,
    });
    return { data: { ok: true } };
  }
}
