import {
  CreateBuildingInput,
  ListBuildingsQuery,
  UpdateBuildingInput,
  type CreateBuilding,
  type ListBuildingsQueryDto,
  type UpdateBuilding,
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

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { BuildingsService } from './buildings.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Authz (D.17) + via-parent scoping +
// withTenant all live in the service. Buildings are addressed both nested
// under their project (list/create) and directly by id (read/update/del).
@Controller()
@UseGuards(AuthGuard, TenantGuard)
export class BuildingsController {
  constructor(private readonly buildings: BuildingsService) {}

  @Get('projects/:projectId/buildings')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(ListBuildingsQuery)) query: ListBuildingsQueryDto,
  ) {
    return this.buildings.list(user, projectId, query);
  }

  @Post('projects/:projectId/buildings')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Body(new ZodValidationPipe(CreateBuildingInput)) body: CreateBuilding,
  ) {
    return { data: await this.buildings.create(user, projectId, body) };
  }

  @Get('buildings/:id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.buildings.get(user, id) };
  }

  @Patch('buildings/:id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateBuildingInput)) body: UpdateBuilding,
  ) {
    return { data: await this.buildings.update(user, id, body) };
  }

  @Delete('buildings/:id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.buildings.archive(user, id);
  }
}
