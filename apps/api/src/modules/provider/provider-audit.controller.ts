/**
 * D.37 / Phase 6.5 — Provider Admin cross-tenant audit search controller.
 *
 * `GET /api/v1/provider/audit` — searches the customers' audit_log
 * with filters (orgId, action prefix, date range) + cursor pagination.
 * Provider's OWN actions are NOT searched here (they live in
 * provider_audit_log, surfaced separately if ever needed — out of
 * scope for D.37).
 */
import {
  ProviderAuditQuerySchema,
  type ApiList,
  type ProviderAuditItem,
  type ProviderAuditQuery,
} from '@emapp/shared-types';
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuditService } from './provider-audit.service';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';

@Controller('provider/audit')
// Two-layer gate + Audit v1.1 SA-6 — see ProviderTenantsController.
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
// Audit v1.1 SA-9 — cross-tenant audit search throttled at 30/min.
// Defends against the "stack 100 req/min × 31-day pages" exfiltration
// pattern even when SA-4 date-range cap is in force.
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class ProviderAuditController {
  constructor(private readonly svc: ProviderAuditService) {}

  @Get()
  async search(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Query(new ZodValidationPipe(ProviderAuditQuerySchema)) query: ProviderAuditQuery,
  ): Promise<ApiList<ProviderAuditItem>> {
    return this.svc.search(actor, reason, query);
  }
}
