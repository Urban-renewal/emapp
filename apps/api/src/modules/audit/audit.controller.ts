import { ListAuditQuery, type ListAuditQueryDto } from '@emapp/shared-types';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { AuditReadService } from './audit-read.service';

// Append-only audit_log: read-only, MANAGER-only, org-scoped (RLS).
@Controller('audit')
@UseGuards(AuthGuard, TenantGuard)
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
