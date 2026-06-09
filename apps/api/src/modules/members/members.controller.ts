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
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { MembersService } from './members.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Org membership administration. As of the owner-approved Gate-2/Gate-6 grant
// (migration 0053), member ADMINISTRATION (invite/update/remove) is held by
// Manager AND Admin/Owner — a Manager can now invite/update/remove org users.
// (ROLE administration — roles.* — and org governance — org.* — remain
// Owner/Admin-only.) members.read is reached by every org role (Manager+/Admin/
// Owner via the export.run ⇒ members.read closure; Viewer/Agent do NOT hold it).
// The capabilities-toggle is a member.update (an agent's JSONB flags are member
// administration).
@Controller('members')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('members.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListMembersQuery)) query: ListMembersQueryDto,
  ) {
    return this.members.list(user, query);
  }

  @Post()
  @RequirePermission('members.invite')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateMemberInput)) body: CreateMember,
  ) {
    return { data: await this.members.create(user, body) };
  }

  @Patch(':userId')
  @RequirePermission('members.update')
  async updateRole(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
    @Body(new ZodValidationPipe(UpdateMemberInput)) body: UpdateMember,
  ) {
    return { data: await this.members.updateRole(user, userId, body) };
  }

  // D.46 — set an agent's capability flags. members.update governance surface.
  // More-specific path than PATCH :userId, so it matches first.
  @Patch(':userId/capabilities')
  @RequirePermission('members.update')
  async updateCapabilities(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
    @Body(new ZodValidationPipe(UpdateAgentCapabilitiesInput)) body: UpdateAgentCapabilities,
  ) {
    return { data: await this.members.updateCapabilities(user, userId, body) };
  }

  @Delete(':userId')
  @HttpCode(204)
  @RequirePermission('members.remove')
  async revoke(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
  ) {
    await this.members.revoke(user, userId);
  }
}
