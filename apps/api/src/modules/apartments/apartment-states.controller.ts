import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { CreateApartmentStateDto, type CreateApartmentState } from './apartment-state.dto';
import { ApartmentStatesService } from './apartment-states.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Slice 2.7 — apartment legal/life-state endpoints.
 *
 * Thin controller: guards + Zod only. The COARSE permission gate is `apartments.read`
 * (read) / `apartments.update` (write) — reusing the existing apartment permission
 * set (NO new permission added). The FINE manager-tier gate + audit + RLS org-
 * isolation live in the service. Apartment-states carry NO PII.
 *
 * Reads/writes are {data}-enveloped (D.16).
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ApartmentStatesController {
  constructor(private readonly states: ApartmentStatesService) {}

  /** List the ACTIVE legal/life states for one apartment. */
  @Get('apartments/:apartmentId/states')
  @RequirePermission('apartments.read')
  async listForApartment(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
  ) {
    return { data: await this.states.listForApartment(user, apartmentId) };
  }

  /** Create a legal/life state on an apartment (manager-gated in the service). */
  @Post('apartments/:apartmentId/states')
  @RequirePermission('apartments.update')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Body(new ZodValidationPipe(CreateApartmentStateDto)) body: CreateApartmentState,
  ) {
    return { data: await this.states.create(user, apartmentId, body) };
  }

  /** Resolve a legal/life state (status transition — manager-gated, not a delete). */
  @Post('apartment-states/:id/resolve')
  @RequirePermission('apartments.update')
  async resolve(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.states.resolve(user, id) };
  }
}
