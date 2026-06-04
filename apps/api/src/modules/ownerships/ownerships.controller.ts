import {
  ListOwnershipsQuery,
  SetOwnershipsInput,
  type ListOwnershipsQueryDto,
  type SetOwnerships,
} from '@emapp/shared-types';
import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { OwnershipsService } from './ownerships.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. The locked Phase-1 constraint
// trigger makes ownership composition ATOMIC per apartment, so the only
// write is a full-set REPLACE (PUT) — one permission `ownerships.set` (D.25),
// NOT a CRUD quad. Reads: active ownerships + the masked apartment→owners view
// (docs/09 §3.13). Record-scoping + withTenant stay in the service.
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OwnershipsController {
  constructor(private readonly ownerships: OwnershipsService) {}

  @Get('apartments/:apartmentId/ownerships')
  @RequirePermission('ownerships.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.ownerships.list(user, apartmentId, query);
  }

  @Get('apartments/:apartmentId/owners')
  @RequirePermission('ownerships.read')
  async apartmentOwners(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.ownerships.listApartmentOwners(user, apartmentId, query);
  }

  // Atomic full-set replace (locked-invariant-faithful). Body owners must
  // be empty (clear) or sum to exactly 100. The single `ownerships.set`
  // permission gates the (PUT) — legacy create/update/delete all map here.
  @Put('apartments/:apartmentId/ownerships')
  @RequirePermission('ownerships.set')
  async replaceSet(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Body(new ZodValidationPipe(SetOwnershipsInput)) body: SetOwnerships,
  ) {
    return { data: await this.ownerships.replaceSet(user, apartmentId, body) };
  }
}
