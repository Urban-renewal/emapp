import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { CreateOwnerStateDto, type CreateOwnerState } from './owner-state.dto';
import { OwnerStatesService } from './owner-states.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Slice 2.5 — owner legal/life-state endpoints.
 *
 * Thin controller: guards + Zod only. The COARSE permission gate is `owners.read`
 * (read) / `owners.update` (write) — reusing the existing owner permission set
 * (NO new permission added). The FINE manager-tier gate + guardian-PII encryption
 * + masking + audit + RLS org-isolation live in the service.
 *
 * Guardian PII is NEVER returned cleartext — the view ships a MASKED guardian
 * label only. Reads/writes are {data}-enveloped (D.16).
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OwnerStatesController {
  constructor(private readonly states: OwnerStatesService) {}

  /** List the ACTIVE legal/life states for one owner (masked guardian). */
  @Get('owners/:ownerId/states')
  @RequirePermission('owners.read')
  async listForOwner(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ownerId', UuidParam) ownerId: string,
  ) {
    return { data: await this.states.listForOwner(user, ownerId) };
  }

  /** Create a legal/life state on an owner (manager-gated in the service). */
  @Post('owners/:ownerId/states')
  @RequirePermission('owners.update')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('ownerId', UuidParam) ownerId: string,
    @Body(new ZodValidationPipe(CreateOwnerStateDto)) body: CreateOwnerState,
  ) {
    return { data: await this.states.create(user, ownerId, body) };
  }

  /** Resolve a legal/life state (status transition — manager-gated, not a delete). */
  @Post('owner-states/:id/resolve')
  @RequirePermission('owners.update')
  async resolve(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.states.resolve(user, id) };
  }
}
