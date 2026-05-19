import {
  AssignTaskInput,
  CreateTaskInput,
  ListTasksQuery,
  UpdateTaskInput,
  type AssignTask,
  type CreateTask,
  type ListTasksQueryDto,
  type UpdateTask,
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

import { TasksService } from './tasks.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

@Controller()
@AuthzResource('tasks')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('tasks')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListTasksQuery)) query: ListTasksQueryDto,
  ) {
    return this.tasks.list(user, query);
  }

  @Post('tasks')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateTaskInput)) body: CreateTask,
  ) {
    return { data: await this.tasks.create(user, body) };
  }

  @Get('tasks/:id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tasks.get(user, id) };
  }

  @Patch('tasks/:id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateTaskInput)) body: UpdateTask,
  ) {
    return { data: await this.tasks.update(user, id, body) };
  }

  @Delete('tasks/:id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.tasks.archive(user, id);
  }

  @Get('tasks/:id/assignees')
  async listAssignees(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tasks.listAssignees(user, id) };
  }

  @Post('tasks/:id/assignees')
  async addAssignee(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(AssignTaskInput)) body: AssignTask,
  ) {
    return { data: await this.tasks.addAssignee(user, id, body) };
  }

  @Delete('tasks/:id/assignees/:userId')
  @HttpCode(204)
  async removeAssignee(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Param('userId', UuidParam) userId: string,
  ) {
    await this.tasks.removeAssignee(user, id, userId);
  }
}
