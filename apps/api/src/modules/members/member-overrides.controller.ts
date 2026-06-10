import {
  ClearMemberOverrideInput,
  SetMemberOverrideInput,
  type ClearMemberOverride,
  type SetMemberOverride,
} from '@emapp/shared-types';
import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { MemberOverridesService } from './member-overrides.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * P2 Phase 2 — per-user permission OVERRIDES (Owner/Admin governance surface).
 *
 * `/members/:userId/overrides`:
 *   GET    → list the member's overrides         (roles.read)
 *   PUT    → set (upsert) one grant/deny override (roles.manage)
 *   DELETE → clear one override by its key        (roles.manage)
 *
 * `roles.manage` is the Owner/Admin role-administration permission (Manager
 * does NOT hold it — member CRUD is `members.*`, role/override administration
 * is `roles.*`). The anti-escalation + last-Owner guards live in the service.
 * The route is a SUBPATH of /members so it shares the member-admin area; it has
 * its OWN authz (roles.manage), stricter than /members (members.*).
 */
@Controller('members/:userId/overrides')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class MemberOverridesController {
  constructor(private readonly overrides: MemberOverridesService) {}

  @Get()
  @RequirePermission('roles.read')
  async list(@CurrentUser() user: AccessTokenPayload, @Param('userId', UuidParam) userId: string) {
    return { data: await this.overrides.list(user, userId) };
  }

  @Put()
  @RequirePermission('roles.manage')
  async set(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
    @Body(new ZodValidationPipe(SetMemberOverrideInput)) body: SetMemberOverride,
  ) {
    return { data: await this.overrides.set(user, userId, body) };
  }

  @Delete()
  @HttpCode(204)
  @RequirePermission('roles.manage')
  async clear(
    @CurrentUser() user: AccessTokenPayload,
    @Param('userId', UuidParam) userId: string,
    @Body(new ZodValidationPipe(ClearMemberOverrideInput)) body: ClearMemberOverride,
  ) {
    await this.overrides.clear(user, userId, body);
  }
}
