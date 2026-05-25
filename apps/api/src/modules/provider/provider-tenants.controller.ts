/**
 * D.37 / Phase 6.5 — Provider Admin tenant LIST controller.
 *
 * `GET /api/v1/provider/tenants` — cursor-paginated org list.
 *
 * Stack of guards/decorators per call (tier isolation D.29):
 *   - ProviderAuthGuard → only `provider_access` JWT with
 *     audience='emapp-provider' passes; org JWT 401s
 *   - @AccessReason header → 400 reason_required on missing
 *   - @CurrentProvider → ProviderTokenPayload + ip/userAgent
 *   - Zod validation pipe → query DTO validated/coerced
 *
 * NO write methods — Gate-6. A future write endpoint requires its own
 * D.NN entry before code review will accept it.
 */
import { ListTenantsQuerySchema, type ApiList, type TenantListItem } from '@emapp/shared-types';
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderTenantsService } from './provider-tenants.service';

@Controller('provider/tenants')
// Two-layer gate (D.37 closeout gap #3):
//   1. ProviderAuthGuard            — JWT audience + session live
//   2. ProviderAuthorizationGuard   — consults PROVIDER_POLICY via
//      canProvider(role,'provider','read').
//
// Audit v1.1 SA-6: ProviderRequestAuditInterceptor runs AFTER guards
// but BEFORE the Zod pipe / handler. Writes `provider.request.received`
// in an autonomous tx so rejected/probed calls leave a forensic trace
// (ISO 27001 A.12.4.1).
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
// Audit v1.1 SA-9 — cap cross-tenant tenant-list browsing at 30/min
// per IP. A compromised Provider Admin or insider can otherwise pull
// 100 req/min × 25 orgs/page = 2500 org-metadata rows/min and
// enumerate the customer graph silently.
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class ProviderTenantsController {
  constructor(private readonly svc: ProviderTenantsService) {}

  @Get()
  async list(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Query(new ZodValidationPipe(ListTenantsQuerySchema)) query: { limit: number; cursor?: string },
  ): Promise<ApiList<TenantListItem>> {
    return this.svc.list(actor, reason, query);
  }
}
