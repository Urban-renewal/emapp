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

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ProjectAssignmentsService } from './project-assignments.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

@Controller()
@UseGuards(AuthGuard, TenantGuard)
export class ProjectAssignmentsController {
  constructor(private readonly assignments: ProjectAssignmentsService) {}

  @Get('projects/:projectId/assignments')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(ListProjectAssignmentsQuery))
    query: ListProjectAssignmentsQueryDto,
  ) {
    return this.assignments.list(user, projectId, query);
  }

  @Post('projects/:projectId/assignments')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Body(new ZodValidationPipe(CreateProjectAssignmentInput)) body: CreateProjectAssignment,
  ) {
    return { data: await this.assignments.create(user, projectId, body) };
  }

  @Delete('assignments/:id')
  @HttpCode(204)
  async unassign(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.assignments.unassign(user, id);
  }
}
