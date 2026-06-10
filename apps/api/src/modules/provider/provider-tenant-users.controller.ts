/**
 * P4 / PLAN-provider-console §3 Tier-1 #1 — Provider Admin "org users
 * management" controller.
 *
 * `GET /api/v1/provider/tenants/:id/users` — the target org's MEMBERS,
 * cursor-paginated, READ-ONLY + PII-MASKED.
 *
 * Guard / decorator stack is IDENTICAL to the tenant-detail endpoint —
 * the other Provider surface that returns masked customer PII:
 *   - ProviderAuthGuard (tier audience emapp-provider, D.29 — org JWT 401s)
 *   - ProviderAuthorizationGuard (PROVIDER_POLICY matrix, read action)
 *   - ProviderRequestAuditInterceptor (Audit v1.1 SA-6 — autonomous
 *     `provider.request.received` row BEFORE the Zod pipe runs)
 *   - @AccessReason header → 400 reason_required if missing
 *   - @CurrentProvider → narrow ProviderActor + ip / userAgent
 *   - ZodValidationPipe on the query DTO (limit / cursor)
 *
 * Path param uses ParseUUIDPipe — a malformed org id is 400 before the
 * service ever opens a Provider session.
 *
 * Throttle mirrors the tenant-DETAIL cap (10/min) — this is a PII-bearing
 * cross-tenant read; the tight cap bounds enumeration of the member graph
 * while leaving room for ops triage across a handful of orgs.
 *
 * READ-ONLY — Gate-6. No write method here; a future write requires its
 * own D.NN entry.
 */
import { ListTenantUsersQuerySchema, type ApiList, type TenantUserItem } from '@emapp/shared-types';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderTenantUsersService } from './provider-tenant-users.service';

@Controller('provider/tenants')
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
// PII-bearing cross-tenant read — same 10/min cap as the tenant-detail
// sample owners (Audit v1.1 SA-9 rationale): enough for ops triage,
// not enough to enumerate the member graph silently.
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class ProviderTenantUsersController {
  constructor(private readonly svc: ProviderTenantUsersService) {}

  @Get(':id/users')
  async list(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query(new ZodValidationPipe(ListTenantUsersQuerySchema))
    query: { limit: number; cursor?: string },
  ): Promise<ApiList<TenantUserItem>> {
    return this.svc.list(actor, reason, id, query);
  }
}
