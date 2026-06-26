import {
  CreateApartmentInput,
  GenerateApartmentsInput,
  ListApartmentsQuery,
  UpdateApartmentInput,
  type CreateApartment,
  type GenerateApartments,
  type ListApartmentsQueryDto,
  type UpdateApartment,
} from '@emapp/shared-types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ApartmentsService } from './apartments.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Authorization is the engine permission
// gate (slice-5a @RequirePermission); the FINE agent gate
// (requireAgentCapability('edit_project_data')) + via-parent assigned-project
// scoping + withTenant stay in the service. Apartments are addressed nested
// under their building (list/create) and directly by id (read/update/del).
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ApartmentsController {
  constructor(private readonly apartments: ApartmentsService) {}

  @Get('buildings/:buildingId/apartments')
  @RequirePermission('apartments.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('buildingId', UuidParam) buildingId: string,
    @Query(new ZodValidationPipe(ListApartmentsQuery)) query: ListApartmentsQueryDto,
  ) {
    return this.apartments.list(user, buildingId, query);
  }

  @Post('buildings/:buildingId/apartments')
  @RequirePermission('apartments.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('buildingId', UuidParam) buildingId: string,
    @Body(new ZodValidationPipe(CreateApartmentInput)) body: CreateApartment,
  ) {
    return { data: await this.apartments.create(user, buildingId, body) };
  }

  // Slice 2.1 — bulk-GENERATE a building's apartments from its shape
  // (floors × apartmentsPerFloor) in ONE manager-confirmed, atomic action.
  // Literal action-suffix route `apartments:generate` — the `::` escapes the
  // colon for find-my-way (a single `:` would parse as a path param). Same
  // write permission (apartments.create) + agent fine gate as the single
  // create; Idempotency-Key is honoured by the global interceptor.
  @Post('buildings/:buildingId/apartments::generate')
  @RequirePermission('apartments.create')
  async generate(
    @CurrentUser() user: AccessTokenPayload,
    @Param('buildingId', UuidParam) buildingId: string,
    @Body(new ZodValidationPipe(GenerateApartmentsInput)) body: GenerateApartments,
  ) {
    return { data: await this.apartments.generate(user, buildingId, body) };
  }

  @Get('apartments/:id')
  @RequirePermission('apartments.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.apartments.get(user, id) };
  }

  @Patch('apartments/:id')
  @RequirePermission('apartments.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateApartmentInput)) body: UpdateApartment,
  ) {
    return { data: await this.apartments.update(user, id, body) };
  }

  @Delete('apartments/:id')
  @HttpCode(204)
  @RequirePermission('apartments.archive')
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.apartments.archive(user, id);
  }
}
