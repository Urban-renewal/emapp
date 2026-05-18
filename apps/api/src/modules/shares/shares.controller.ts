import {
  CreateShareInput,
  ListSharesQuery,
  UpdateShareInput,
  type CreateShare,
  type ListSharesQueryDto,
  type UpdateShare,
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

import { SharesService } from './shares.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Manager-side grant management. Shares are nested under their project
// (list/create) and addressed by id (update perms / revoke).
@Controller()
@UseGuards(AuthGuard, TenantGuard)
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Get('projects/:projectId/shares')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(ListSharesQuery)) query: ListSharesQueryDto,
  ) {
    return this.shares.list(user, projectId, query);
  }

  @Post('projects/:projectId/shares')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Body(new ZodValidationPipe(CreateShareInput)) body: CreateShare,
  ) {
    return { data: await this.shares.create(user, projectId, body) };
  }

  @Patch('shares/:id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateShareInput)) body: UpdateShare,
  ) {
    return { data: await this.shares.update(user, id, body) };
  }

  @Delete('shares/:id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.shares.revoke(user, id);
  }
}
