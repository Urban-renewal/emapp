import {
  CreateNoteInput,
  ListNotesQuery,
  UpdateNoteInput,
  type CreateNote,
  type ListNotesQueryDto,
  type UpdateNote,
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

import { NotesService } from './notes.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

@Controller('notes')
@AuthzResource('notes')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListNotesQuery)) query: ListNotesQueryDto,
  ) {
    return this.notes.list(user, query);
  }

  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateNoteInput)) body: CreateNote,
  ) {
    return { data: await this.notes.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.notes.get(user, id) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateNoteInput)) body: UpdateNote,
  ) {
    return { data: await this.notes.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.notes.archive(user, id);
  }
}
