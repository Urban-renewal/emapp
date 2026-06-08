import { OrgSettingsPatchSchema, type OrgSettingsPatch } from '@emapp/shared-types';
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { OrgSettingsService } from './org-settings.service';

/**
 * P6-1 — the admin read/write surface for the per-org settings seam
 * (`organizations.settings` jsonb). The seam already powers the notifications
 * engine; this is the missing CONFIG surface so an admin can change it end-to-
 * end.
 *
 * AUTHZ (the IAM catalog, NOT a role string):
 *   GET   → `org.settings.read`   (the org-settings READ permission)
 *   PATCH → `org.settings.update` (the org-settings WRITE permission)
 * Both live in the `org.*` GOVERNANCE block of the catalog. Per the seeded
 * system roles (`system-roles.ts`), these are held by **Owner + Admin** — the
 * D.17 "Manager" role is `ALL_OPERATIONAL` which EXCLUDES `org.*`, so a Manager
 * is intentionally NOT an org-settings writer in the IAM model. (The task brief
 * says "manager-only write"; the precise, enforced contract is the
 * `org.settings.update` PERMISSION — the admin tier — which is the single
 * source of truth the AuthorizationGuard checks. A Viewer/Agent holds neither
 * permission and is rejected 403.) Wiring against the permission, not a role
 * string, is the project rule (`use-permissions.ts`, members.controller.ts).
 *
 * Every response is `{ data: <resolved OrgSettings> }` (D.16). The body of the
 * PATCH is validated by `OrgSettingsPatchSchema` (partial, unknown-key-strict).
 */
@Controller('org/settings')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OrgSettingsController {
  constructor(private readonly settings: OrgSettingsService) {}

  @Get()
  @RequirePermission('org.settings.read')
  async get(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.settings.get(user) };
  }

  @Patch()
  @RequirePermission('org.settings.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(OrgSettingsPatchSchema)) body: OrgSettingsPatch,
  ) {
    return { data: await this.settings.update(user, body) };
  }
}
