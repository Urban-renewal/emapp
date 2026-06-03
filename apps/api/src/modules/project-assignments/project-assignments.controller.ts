import {
  CreateProjectAssignmentInput,
  ListProjectAssignmentsQuery,
  type CreateProjectAssignment,
  type ListProjectAssignmentsQueryDto,
} from '@emapp/shared-types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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

import { ProjectAssignmentsService } from './project-assignments.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Project-assignment is OPERATIONAL project-staffing (assign an Agent to a
// project), NOT org-role governance. It uses DEDICATED operational permissions:
// list → project_assignments.read (every in-org role reads, legacy read: ALL),
// create + unassign → project_assignments.manage (Manager/Admin/Owner, legacy
// MGR). This restores Manager's ability to staff their own projects, which the
// authz cutover lost by mapping staffing onto roles.* (Admin/Owner-only).
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ProjectAssignmentsController {
  constructor(private readonly assignments: ProjectAssignmentsService) {}

  @Get('projects/:projectId/assignments')
  @RequirePermission('project_assignments.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(ListProjectAssignmentsQuery))
    query: ListProjectAssignmentsQueryDto,
  ) {
    return this.assignments.list(user, projectId, query);
  }

  @Post('projects/:projectId/assignments')
  @RequirePermission('project_assignments.manage')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Body(new ZodValidationPipe(CreateProjectAssignmentInput)) body: CreateProjectAssignment,
  ) {
    return { data: await this.assignments.create(user, projectId, body) };
  }

  @Delete('assignments/:id')
  @HttpCode(204)
  @RequirePermission('project_assignments.manage')
  async unassign(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.assignments.unassign(user, id);
  }
}
