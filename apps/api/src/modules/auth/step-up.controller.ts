import { StepUpVerifySchema, type StepUpVerifyDto } from '@emapp/shared-types';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

import type { AccessTokenPayload } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthGuard } from './guards/auth.guard';
import { StepUpService } from './step-up.service';

/**
 * 7b-OTP (D-P5.5) — PII step-up unlock for AUTHENTICATED org users.
 *
 * POST /api/v1/auth/step-up/request → email a 6-digit OTP to the caller
 * (rate-limited 3/15min in the service; the @Throttle is the per-IP brake,
 * mirroring the tenant OTP routes). POST /api/v1/auth/step-up/verify { code }
 * → stamp pii_unlocked_at on the CALLER'S CURRENT session only.
 *
 * The OTP code is NEVER logged and NEVER returned in production. Dev/QA
 * only (7c, EXPOSE_INVITE_TOKEN pattern): the request response adds { code }
 * IFF EXPOSE_STEP_UP_CODE === 'true' AND NODE_ENV is development|test.
 */
@Controller('auth/step-up')
@UseGuards(AuthGuard)
export class StepUpController {
  constructor(private readonly stepUp: StepUpService) {}

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('request')
  @HttpCode(200)
  async request(@CurrentUser() user: AccessTokenPayload) {
    // 7c — `code` is present ONLY under the dev/QA exposure gate
    // (EXPOSE_STEP_UP_CODE === 'true' AND NODE_ENV development|test, read
    // at request time in the service). Fail-closed in production.
    const { code } = await this.stepUp.request(user);
    return { data: { ok: true, ...(code ? { code } : {}) } };
  }

  @Throttle({ default: { limit: 10, ttl: 900000 } })
  @Post('verify')
  @HttpCode(200)
  // Param-level pipe (NOT @UsePipes): a handler-level pipe would also run on
  // the @CurrentUser() payload and reject it against the body schema.
  async verify(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(StepUpVerifySchema)) dto: StepUpVerifyDto,
  ) {
    await this.stepUp.verify(user, dto.code);
    return { data: { ok: true } };
  }
}
