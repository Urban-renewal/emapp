import {
  CreateTabuExtractionInput,
  ListOwnershipsQuery,
  type CreateTabuExtraction,
  type ListOwnershipsQueryDto,
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

import { TabuExtractionsService } from './tabu-extractions.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Tabu extractions are apartment-attached
// (S7a "Tabu extraction envelope + lifecycle"), so they reuse the apartments
// permission gate — read = `apartments.read`, create (a WRITE) =
// `apartments.update` (the project/apartment write permission). The fine agent
// gate (requireAgentCapability('edit_project_data')) + via-parent assigned-
// project scoping + the finalized/apartment-scope source-doc checks + withTenant
// all stay in the service. List/create are nested under the apartment; getOne is
// by extraction id. The cursor query reuses `ListOwnershipsQuery` (limit +
// cursor — identical shape, no new schema).
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class TabuExtractionsController {
  constructor(private readonly tabu: TabuExtractionsService) {}

  @Get('apartments/:apartmentId/tabu-extractions')
  @RequirePermission('apartments.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.tabu.list(user, apartmentId, query);
  }

  @Post('apartments/:apartmentId/tabu-extractions')
  @RequirePermission('apartments.update')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Body(new ZodValidationPipe(CreateTabuExtractionInput)) body: CreateTabuExtraction,
  ) {
    return { data: await this.tabu.create(user, apartmentId, body) };
  }

  @Get('tabu-extractions/:id')
  @RequirePermission('apartments.read')
  async getOne(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tabu.getOne(user, id) };
  }
}
