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

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ProjectsService } from './projects.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards (auth + tenant) + Zod validation only. Authorization
// is the engine permission gate (slice-5a @RequirePermission, resolved by
// AuthorizationGuard); record-scoping (agent → assigned project) + data access
// (withTenant) live in the service. Every route is /api/v1/projects (D.10).
@Controller('projects')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission('projects.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListProjectsQuery)) query: ListProjectsQueryDto,
  ) {
    return this.projects.list(user, query);
  }

  @Get(':id')
  @RequirePermission('projects.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.projects.get(user, id) };
  }

  @Post()
  @RequirePermission('projects.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateProjectInput)) body: CreateProject,
  ) {
    return { data: await this.projects.create(user, body) };
  }

  @Patch(':id')
  @RequirePermission('projects.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateProjectInput)) body: UpdateProject,
  ) {
    return { data: await this.projects.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('projects.archive')
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.projects.archive(user, id);
  }
}
