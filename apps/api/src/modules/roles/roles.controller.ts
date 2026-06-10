import {
  AssignRoleInput,
  CreateCustomRoleInput,
  RevokeRoleInput,
  UpdateCustomRoleInput,
  type AssignRole,
  type CreateCustomRole,
  type RevokeRole,
  type UpdateCustomRole,
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

import { RolesService } from './roles.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Role administration (P2 Phase 1) — org-custom permission groups + assign/revoke.
 *
 * Gating (the locked boundary, IAM §4 / system-roles.ts):
 *   - LIST + CATALOG → `roles.read` (held by every org role incl. Viewer).
 *   - CREATE / UPDATE / DELETE custom roles → `roles.manage` — Owner/Admin ONLY
 *     (a Manager does NOT hold `roles.manage`, so it can NEVER mint a role).
 *   - ASSIGN → `roles.assign`; REVOKE → `roles.revoke` — Owner/Admin only.
 *
 * The AuthorizationGuard is the COARSE org-scope gate. The FINE anti-escalation
 * boundary (subset of the actor's effective set; governance `roles.*` / `org.*` are
 * Owner-only; tier guard for Owner/Admin grants; last-Owner safety) lives in the
 * service and is enforced on every mutating call. See `custom-role-authz.ts`.
 */
@Controller('roles')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('roles.read')
  async list(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.roles.list(user) };
  }

  // The grantable permission catalog (drives the FE picker; never hardcoded FE-side).
  @Get('catalog')
  @RequirePermission('roles.read')
  catalog() {
    return { data: this.roles.catalog() };
  }

  @Post()
  @RequirePermission('roles.manage')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateCustomRoleInput)) body: CreateCustomRole,
  ) {
    return { data: await this.roles.create(user, body) };
  }

  @Patch(':id')
  @RequirePermission('roles.manage')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateCustomRoleInput)) body: UpdateCustomRole,
  ) {
    return { data: await this.roles.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('roles.manage')
  async remove(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.roles.remove(user, id);
  }

  // ── assignment surface ─────────────────────────────────────────────────────

  @Post('assignments')
  @HttpCode(204)
  @RequirePermission('roles.assign')
  async assign(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(AssignRoleInput)) body: AssignRole,
  ) {
    await this.roles.assign(user, body);
  }

  @Delete('assignments')
  @HttpCode(204)
  @RequirePermission('roles.revoke')
  async revoke(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(RevokeRoleInput)) body: RevokeRole,
  ) {
    await this.roles.revoke(user, body);
  }
}
