import {
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
  type CreateProject,
  type ListProjectsQueryDto,
  type UpdateProject,
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

import { ProjectsService } from './projects.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards (auth + tenant) + Zod validation only. ALL
// authorization (D.17 role matrix) and data access (withTenant) live in
// the service. Every route is /api/v1/projects (global prefix, D.10).
@Controller('projects')
@UseGuards(AuthGuard, TenantGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListProjectsQuery)) query: ListProjectsQueryDto,
  ) {
    return this.projects.list(user, query);
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.projects.get(user, id) };
  }

  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateProjectInput)) body: CreateProject,
  ) {
    return { data: await this.projects.create(user, body) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateProjectInput)) body: UpdateProject,
  ) {
    return { data: await this.projects.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.projects.archive(user, id);
  }
}
