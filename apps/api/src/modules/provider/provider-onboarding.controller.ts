/**
 * D.45 — Provider Admin onboarding controller.
 *
 * `POST /api/v1/provider/tenants` — create an Org + invite its first
 * Manager. Lives in a SEPARATE controller from the read list
 * (`ProviderTenantsController` owns `GET /provider/tenants`) so the
 * create verb is isolated; Nest routes them by method with no conflict.
 *
 * Guard / decorator stack — identical to the suspend write surface
 * (D.49): provider JWT → PROVIDER_POLICY `write` gate → audit-first
 * interceptor → mandatory access_reason → narrow actor. The throttle is
 * the same 10/min write posture (onboarding is not a high-rate action).
 */
import {
  OnboardOrgBodySchema,
  type OnboardOrgBody,
  type OnboardOrgResult,
} from '@emapp/shared-types';
import { Body, Controller, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { RequireProviderAction } from './provider-authz.decorators';
import { ProviderOnboardingService } from './provider-onboarding.service';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';

@Controller('provider/tenants')
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class ProviderOnboardingController {
  constructor(private readonly svc: ProviderOnboardingService) {}

  @Post()
  @RequireProviderAction('write')
  async onboard(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Body(new ZodValidationPipe(OnboardOrgBodySchema)) body: OnboardOrgBody,
  ): Promise<{ data: OnboardOrgResult }> {
    const data = await this.svc.onboard(actor, reason, body);
    return { data };
  }
}
