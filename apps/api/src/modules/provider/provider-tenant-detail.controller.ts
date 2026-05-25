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
import { Controller, Get, Param, ParseUUIDPipe, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderTenantDetailService } from './provider-tenant-detail.service';

@Controller('provider/tenants')
// Two-layer gate + Audit v1.1 SA-6 audit-on-request interceptor — see
// ProviderTenantsController for the full rationale.
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
// Audit v1.1 SA-9 — tenant-detail is the ONLY Provider endpoint that
// returns PII (5 masked sample owners per tenant). Tighter cap of
// 10/min: enough for ops triage of multiple tenants in succession;
// not enough to enumerate the customer graph. Combined with the
// audit-on-request interceptor, a compromised admin is left with at
// most 10 audit-trail-visible PII drill-downs per minute.
@Throttle({ default: { limit: 10, ttl: 60_000 } })
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
