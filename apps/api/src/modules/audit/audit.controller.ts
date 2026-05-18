import { ListAuditQuery, type ListAuditQueryDto } from '@emapp/shared-types';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { AuditReadService } from './audit-read.service';

// Append-only audit_log: read-only, MANAGER-only, org-scoped (RLS).
@Controller('audit')
@AuthzResource('audit')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class AuditController {
  constructor(private readonly audit: AuditReadService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListAuditQuery)) query: ListAuditQueryDto,
  ) {
    return this.audit.list(user, query);
  }
}
