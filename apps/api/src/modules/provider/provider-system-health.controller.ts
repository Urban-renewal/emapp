/**
 * D.37 / Phase 6.5 — Provider system-health controller.
 *
 * `GET /api/v1/provider/system-health` — read-only gauges for the
 * ops dashboard. No path params, no query params (intentionally
 * simple — gauges are gauges).
 */
import type { SystemHealth } from '@emapp/shared-types';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderSystemHealthService } from './provider-system-health.service';

@Controller('provider/system-health')
@UseGuards(ProviderAuthGuard)
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
