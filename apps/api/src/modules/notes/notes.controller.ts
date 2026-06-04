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
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { NotesService } from './notes.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Notes: any org write-role authors; manager-or-AUTHOR edits/deletes (the
// authorship record-scope lives in the service — NOT a capability). The engine
// permission gate is the coarse layer; viewer is denied at the gate (holds no
// notes.create/update/archive).
@Controller('notes')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @RequirePermission('notes.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListNotesQuery)) query: ListNotesQueryDto,
  ) {
    return this.notes.list(user, query);
  }

  @Post()
  @RequirePermission('notes.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateNoteInput)) body: CreateNote,
  ) {
    return { data: await this.notes.create(user, body) };
  }

  @Get(':id')
  @RequirePermission('notes.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.notes.get(user, id) };
  }

  @Patch(':id')
  @RequirePermission('notes.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateNoteInput)) body: UpdateNote,
  ) {
    return { data: await this.notes.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('notes.archive')
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.notes.archive(user, id);
  }
}
