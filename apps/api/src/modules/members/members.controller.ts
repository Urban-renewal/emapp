import {
  CreateMemberInput,
  ListMembersQuery,
  UpdateAgentCapabilitiesInput,
  UpdateMemberInput,
  type CreateMember,
  type ListMembersQueryDto,
  type UpdateAgentCapabilities,
  type UpdateMember,
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

import { MembersService } from './members.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Manager-only org membership administration (D.26: @AuthzResource
// 'members' = manager for every action; the guard enforces it centrally).
@Controller('members')
@AuthzResource('members')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListMembersQuery)) query: ListMembersQueryDto,
  ) {
    return this.members.list(user, query);
  }

  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateMemberInput)) body: CreateMember,
  ) {
    return { data: await this.members.create(user, body) };
  }

  @Patch(':userId')
  async updateRole(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
    @Body(new ZodValidationPipe(UpdateMemberInput)) body: UpdateMember,
  ) {
    return { data: await this.members.updateRole(user, userId, body) };
  }

  // D.46 — set an agent's capability flags. Manager-only (inherited from the
  // controller-wide @AuthzResource('members') gate). More-specific path than
  // PATCH :userId, so it matches first.
  @Patch(':userId/capabilities')
  async updateCapabilities(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
    @Body(new ZodValidationPipe(UpdateAgentCapabilitiesInput)) body: UpdateAgentCapabilities,
  ) {
    return { data: await this.members.updateCapabilities(user, userId, body) };
  }

  @Delete(':userId')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
  ) {
    await this.members.revoke(user, userId);
  }
}
