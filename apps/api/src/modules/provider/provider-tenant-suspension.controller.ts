/**
 * D.49 — Provider Admin tenant suspend / reactivate controller.
 *
 * `POST /api/v1/provider/tenants/:id/suspend`
 * `POST /api/v1/provider/tenants/:id/reactivate`
 *
 * Guard / decorator stack (identical tier isolation to the read
 * endpoints, PLUS the D.49 write gate):
 *   - ProviderAuthGuard            — emapp-provider JWT only (D.29)
 *   - ProviderAuthorizationGuard   — consults PROVIDER_POLICY; the
 *     @RequireProviderAction('write') below makes it check
 *     canProvider(role,'provider','write') instead of the 'read' default
 *   - ProviderRequestAuditInterceptor — autonomous pre-handler audit row
 *   - @AccessReason header         — 400 reason_required when missing;
 *     becomes the forensic `reason` on every audit row
 *   - @CurrentProvider             — narrow actor (sub + ip/userAgent)
 *   - ParseUUIDPipe                — malformed id → 400 before any session
 *
 * Tighter throttle (10/min) — same posture as the PII detail endpoint:
 * a write surface should not be enumerable/automatable at speed.
 */
import {
  SuspendTenantBodySchema,
  type SuspendTenantBody,
  type TenantSuspensionState,
} from '@emapp/shared-types';
import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';

import { AccessReason } from './access-reason.decorator';
import { CurrentProvider, type ProviderPrincipal } from './current-provider.decorator';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { RequireProviderAction } from './provider-authz.decorators';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderTenantSuspensionService } from './provider-tenant-suspension.service';

@Controller('provider/tenants')
@UseGuards(ProviderAuthGuard, ProviderAuthorizationGuard)
@UseInterceptors(ProviderRequestAuditInterceptor)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class ProviderTenantSuspensionController {
  constructor(private readonly svc: ProviderTenantSuspensionService) {}

  @Post(':id/suspend')
  @RequireProviderAction('write')
  async suspend(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body(new ZodValidationPipe(SuspendTenantBodySchema)) body: SuspendTenantBody,
  ): Promise<{ data: TenantSuspensionState }> {
    const data = await this.svc.suspend(actor, reason, id, body.note ?? null);
    return { data };
  }

  @Post(':id/reactivate')
  @RequireProviderAction('write')
  async reactivate(
    @CurrentProvider() actor: ProviderPrincipal,
    @AccessReason() reason: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ data: TenantSuspensionState }> {
    const data = await this.svc.reactivate(actor, reason, id);
    return { data };
  }
}
