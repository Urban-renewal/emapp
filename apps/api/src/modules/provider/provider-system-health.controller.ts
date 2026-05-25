/**
 * D.37 / Phase 6.5 — Provider system-health controller.
 *
 * `GET /api/v1/provider/system-health` — read-only gauges for the
 * ops dashboard. No path params, no query params (intentionally
 * simple — gauges are gauges).
 */
import type { SystemHealth } from '@emapp/shared-types';
import { Controller, Get, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderSystemHealthService } from './provider-system-health.service';

@Controller('provider/system-health')
// Two-layer gate + Audit v1.1 SA-6 — see ProviderTenantsController.
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
// Audit v1.1 SA-9 — system-health is the most-polled endpoint (5s
// dashboard cadence × multiple admins). 30/min is generous enough
// for live dashboards via short-lived sessions, low enough that an
// abusive consumer can't drown the audit log. The CC-5 in-process
// cache means most polls don't even hit the DB.
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class ProviderSystemHealthController {
  constructor(private readonly svc: ProviderSystemHealthService) {}

  @Get()
  async read(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
  ): Promise<{ data: SystemHealth }> {
    const data = await this.svc.read(actor, reason);
    return { data };
  }
}
