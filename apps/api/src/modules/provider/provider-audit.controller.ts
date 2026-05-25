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
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuditService } from './provider-audit.service';

@Controller('provider/audit')
@UseGuards(ProviderAuthGuard)
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
