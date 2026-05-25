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
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderTenantsService } from './provider-tenants.service';

@Controller('provider/tenants')
@UseGuards(ProviderAuthGuard)
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
