import {
  CreateApartmentInput,
  ListApartmentsQuery,
  UpdateApartmentInput,
  type CreateApartment,
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
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ApartmentsService } from './apartments.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Authz (D.17) + via-parent scoping +
// withTenant live in the service. Apartments are addressed nested under
// their building (list/create) and directly by id (read/update/del).
@Controller()
@AuthzResource('apartments')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ApartmentsController {
  constructor(private readonly apartments: ApartmentsService) {}

  @Get('buildings/:buildingId/apartments')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('buildingId', UuidParam) buildingId: string,
    @Query(new ZodValidationPipe(ListApartmentsQuery)) query: ListApartmentsQueryDto,
  ) {
    return this.apartments.list(user, buildingId, query);
  }

  @Post('buildings/:buildingId/apartments')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('buildingId', UuidParam) buildingId: string,
    @Body(new ZodValidationPipe(CreateApartmentInput)) body: CreateApartment,
  ) {
    return { data: await this.apartments.create(user, buildingId, body) };
  }

  @Get('apartments/:id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.apartments.get(user, id) };
  }

  @Patch('apartments/:id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateApartmentInput)) body: UpdateApartment,
  ) {
    return { data: await this.apartments.update(user, id, body) };
  }

  @Delete('apartments/:id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.apartments.archive(user, id);
  }
}
