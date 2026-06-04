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

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission, TenantScoped } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { SharesService } from './shares.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Share grant management. The new permission catalog models shares as
// create + revoke ONLY (no `shares.read` / `shares.update` permission — a share
// is a contractor delivery channel, not a separately-listed read resource;
// there is no in-place edit, you revoke + re-issue). So list + perms-edit carry
// @TenantScoped (NO_ENGINE_EQUIVALENT — authenticated org member; the service's
// own requireManager + assertProjectVisible still scope them). create/link +
// revoke carry the real permissions. NOTE: shares.service.requireManager keeps
// writes manager-only at the service layer regardless of the coarse gate, so
// the equivalence-map "Agent gains shares.create/revoke" coarse divergence is
// not an effective widening here.
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Get('projects/:projectId/shares')
  @TenantScoped()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(ListSharesQuery)) query: ListSharesQueryDto,
  ) {
    return this.shares.list(user, projectId, query);
  }

  @Post('projects/:projectId/shares')
  @RequirePermission('shares.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Body(new ZodValidationPipe(CreateShareInput)) body: CreateShare,
  ) {
    return { data: await this.shares.create(user, projectId, body) };
  }

  @Patch('shares/:id')
  @TenantScoped()
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateShareInput)) body: UpdateShare,
  ) {
    return { data: await this.shares.update(user, id, body) };
  }

  @Delete('shares/:id')
  @HttpCode(204)
  @RequirePermission('shares.revoke')
  async revoke(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.shares.revoke(user, id);
  }

  // D2-DEF-1 — mint a share-access link (the contractor credential) for an
  // existing share. Issuing a share credential is a `shares.create`-class
  // action (manager-only in the service via requireManager).
  @Post('shares/:id/link')
  @RequirePermission('shares.create')
  async link(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.shares.getShareLink(user, id) };
  }
}
