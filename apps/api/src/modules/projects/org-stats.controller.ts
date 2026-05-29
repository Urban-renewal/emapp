import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzResource } from '../../common/authz/authz.decorators';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ProjectsService } from './projects.service';

/**
 * Org-level aggregate stats — single endpoint backing the home dashboard
 * KPI cards (`apps/web/src/app/[locale]/(dashboard)/page.tsx`).
 *
 * Lives in a separate controller (not on /projects) because the URL
 * `/api/v1/org/stats` reflects the semantic scope (org-wide, not project-
 * scoped), and `/projects/stats` would collide with the `/projects/:id`
 * UUID-validated route.
 *
 * Authz reuses the `projects` resource → all org users (manager/agent/
 * viewer) can read; tenant + provider tiers are denied at the guard level
 * (per the D.17 policy matrix). RLS isolation is enforced via withTenant
 * inside the service.
 */
@Controller('org')
@AuthzResource('projects')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OrgStatsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('stats')
  async stats(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.projects.orgStats(user) };
  }
}
