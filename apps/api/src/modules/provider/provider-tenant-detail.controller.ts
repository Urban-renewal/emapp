/**
 * D.37 / Phase 6.5 — Provider Admin tenant DETAIL controller.
 *
 * `GET /api/v1/provider/tenants/:id` — single org with extended
 * counts + 5 PII-masked sample owners.
 *
 * Guard / decorator stack identical to the list endpoint:
 *   - ProviderAuthGuard (tier audience emapp-provider, D.29)
 *   - @AccessReason header → 400 reason_required if missing
 *   - @CurrentProvider → ProviderTokenPayload + ip / userAgent
 *
 * Path param uses Nest's ParseUUIDPipe — malformed UUID → 400
 * before the service ever sees it (no point opening a Provider
 * session for a syntactically invalid id).
 */
import type { TenantDetail } from '@emapp/shared-types';
import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';

import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderTenantDetailService } from './provider-tenant-detail.service';

@Controller('provider/tenants')
// Two-layer gate — see ProviderTenantsController for the rationale.
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
export class ProviderTenantDetailController {
  constructor(private readonly svc: ProviderTenantDetailService) {}

  @Get(':id')
  async get(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ data: TenantDetail }> {
    const data = await this.svc.get(actor, reason, id);
    return { data };
  }
}
