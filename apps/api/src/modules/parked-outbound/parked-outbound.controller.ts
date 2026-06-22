import {
  CountParkedOutboundQuery,
  ListParkedOutboundQuery,
  ResolveParkedOutboundInput,
  type CountParkedOutboundQueryDto,
  type ListParkedOutboundQueryDto,
  type ResolveParkedOutboundInputDto,
} from '@emapp/shared-types';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ParkedOutboundService } from './parked-outbound.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * PARKED-OUTBOUND ops controller (Autonomous Master Plan — the #509
 * observability gap). The manager-facing read + resolve over the EXISTING
 * `outbound_ledger` table's stuck `pending_send` rows.
 *
 * AUTHZ posture (mirrors the proposals controller — no permission-catalog
 * churn): the parked rows are reminder sends (signature-chase), so the existing
 * `signature_requests.*` gates fit exactly:
 *   - GET  …                → `signature_requests.read` (reading the chase surface).
 *   - GET  …/count          → `signature_requests.read`.
 *   - POST …/:id/resolve    → `signature_requests.send`  (resolving can RE-ENABLE
 *                              a governed retry on `failed`, so it is the send-class
 *                              capability — even though resolve NEVER itself sends).
 * The service ADDITIONALLY enforces `requireManager` on every op (defense in
 * depth — this surface is manager-only), and RLS isolates per-org. Every handler
 * declares a gate so AuthorizationGuard never fails open by omission.
 */
@Controller('parked-outbound')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ParkedOutboundController {
  constructor(private readonly parked: ParkedOutboundService) {}

  @Get()
  @RequirePermission('signature_requests.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListParkedOutboundQuery)) query: ListParkedOutboundQueryDto,
  ) {
    return this.parked.list(user, query);
  }

  @Get('count')
  @RequirePermission('signature_requests.read')
  async count(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(CountParkedOutboundQuery)) query: CountParkedOutboundQueryDto,
  ) {
    return { data: await this.parked.count(user, query) };
  }

  @Post(':id/resolve')
  @RequirePermission('signature_requests.send')
  async resolve(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(ResolveParkedOutboundInput)) body: ResolveParkedOutboundInputDto,
  ) {
    return { data: await this.parked.resolve(user, id, body) };
  }
}
