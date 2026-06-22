import { ListProposalsQuery, type ListProposalsQueryDto } from '@emapp/shared-types';
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ProposalsService } from './proposals.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Approval-Inbox controller (Autonomous Master Plan, Phase 1) — the BE read +
 * approve/reject the FE inbox drives.
 *
 * AUTHZ posture — the DEDICATED `proposals.*` permission family (granted to
 * manager-and-above ONLY; see system-roles.ts). The routes previously BORROWED
 * `signature_requests.*`, which was correct when the only kind was
 * signature-reissue but went semantically wrong once non-signature kinds landed
 * (e.g. `task.create` — an agent holding `signature_requests.send` passed the
 * route guard, stopped only by the service `requireManager`). The route gates
 * now match the surface:
 *   - GET /proposals    → `proposals.read`     (list the inbox).
 *   - POST …/approve    → `proposals.approve`  (one-click confirm a draft).
 *   - POST …/reject     → `proposals.reject`   (dismiss a draft).
 * THE BINDING GATE IS UNCHANGED: `ProposalsService.requireManager` on EVERY op
 * (defense in depth + the inbox is manager-only) PLUS the replayed gated method's
 * own capability check at execute time — those stay the authoritative gate. This
 * is a TIGHTENING of the coarse route gate, not a security fix: a non-manager now
 * fails at the guard too (not only the service), and the permissions no longer
 * widen WHO can approve (manager-only is preserved). RLS isolates per-org. Every
 * handler declares a gate so AuthorizationGuard never fails open by omission.
 */
@Controller('proposals')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  @RequirePermission('proposals.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListProposalsQuery)) query: ListProposalsQueryDto,
  ) {
    return this.proposals.list(user, query);
  }

  @Post(':id/approve')
  @RequirePermission('proposals.approve')
  async approve(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.proposals.approve(user, id) };
  }

  @Post(':id/reject')
  @RequirePermission('proposals.reject')
  async reject(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.proposals.reject(user, id) };
  }
}
