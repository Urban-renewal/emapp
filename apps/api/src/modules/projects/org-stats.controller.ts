import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
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
 * Authz reuses the `projects.read` permission → all org users
 * (manager/agent/viewer) can read; tenant + provider tiers hold no org
 * role_assignment, so the engine denies them. RLS isolation is enforced via
 * withTenant inside the service.
 */
@Controller('org')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OrgStatsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('stats')
  @RequirePermission('projects.read')
  async stats(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.projects.orgStats(user) };
  }

  /**
   * E2 Wave-2 B1 — the org-wide "signature pulse" feed for the board-first home
   * (E2.1): per-project attention rows (ordered by urgency), the `needsHuman`
   * bucket, and header `buckets` counts. Same `projects.read` gate as `stats`
   * (all org roles); agent-scope (assigned projects only) + RLS org-isolation
   * are enforced INSIDE the service. No PII — counts/percentages/timestamps only.
   */
  @Get('signature-pulse')
  @RequirePermission('projects.read')
  async signaturePulse(@CurrentUser() user: AccessTokenPayload) {
    return { data: await this.projects.signaturePulse(user) };
  }
}
