import {
  ListOwnershipsQuery,
  SetOwnershipsInput,
  type ListOwnershipsQueryDto,
  type SetOwnerships,
} from '@emapp/shared-types';
import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { OwnershipsService } from './ownerships.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. The locked Phase-1 constraint
// trigger makes ownership composition ATOMIC per apartment, so the only
// write is a full-set REPLACE (PUT). Reads: active ownerships + the
// masked apartment→owners view (docs/09 §3.13).
@Controller()
@UseGuards(AuthGuard, TenantGuard)
export class OwnershipsController {
  constructor(private readonly ownerships: OwnershipsService) {}

  @Get('apartments/:apartmentId/ownerships')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.ownerships.list(user, apartmentId, query);
  }

  @Get('apartments/:apartmentId/owners')
  async apartmentOwners(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.ownerships.listApartmentOwners(user, apartmentId, query);
  }

  // Atomic full-set replace (locked-invariant-faithful). Body owners must
  // be empty (clear) or sum to exactly 100.
  @Put('apartments/:apartmentId/ownerships')
  async replaceSet(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Body(new ZodValidationPipe(SetOwnershipsInput)) body: SetOwnerships,
  ) {
    return { data: await this.ownerships.replaceSet(user, apartmentId, body) };
  }
}
