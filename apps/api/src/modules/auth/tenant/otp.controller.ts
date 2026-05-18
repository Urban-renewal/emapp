import { serverEnv } from '@emapp/config';
import { OtpRequestSchema, OtpVerifySchema } from '@emapp/shared-types';
import type { OtpRequestDto, OtpVerifyDto } from '@emapp/shared-types';
import { Body, Controller, HttpCode, Post, Res, UsePipes } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';

import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

import { OtpService } from './otp.service';

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
  async request(@Body() dto: OtpRequestDto) {
    await this.otp.request(dto.phone);
    return { data: { ok: true } };
  }

  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('verify')
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(OtpVerifySchema))
  async verify(@Body() dto: OtpVerifyDto, @Res({ passthrough: true }) res: FastifyReply) {
    const r = await this.otp.verify(dto.phone, dto.code);
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
