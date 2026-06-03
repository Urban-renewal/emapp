import { ListAuditQuery, type ListAuditQueryDto } from '@emapp/shared-types';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { AuditReadService } from './audit-read.service';

// Append-only audit_log: read-only, org-scoped (RLS). Engine gate =
// `audit.read` (held by Owner/Admin/Manager/Agent/Viewer in the new taxonomy —
// the all-reads surface; this is the documented (C) read-widen divergence vs
// the legacy manager-only matrix).
@Controller('audit')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class AuditController {
  constructor(private readonly audit: AuditReadService) {}

  @Get()
  @RequirePermission('audit.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListAuditQuery)) query: ListAuditQueryDto,
  ) {
    return this.audit.list(user, query);
  }
}
