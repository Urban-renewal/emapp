import {
  ListProposalsQuery,
  ProposalPendingCountQuery,
  type ListProposalsQueryDto,
  type ProposalPendingCountQueryDto,
} from '@emapp/shared-types';
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
 * approve/reject the FE inbox will drive (the FE is a SEPARATE follow-on slice).
 *
 * AUTHZ posture (no permission-catalog churn in the foundation slice): the
 * proposal kinds so far are `signature_request.reissue` (APPROVE re-issues a
 * signing link) and `reminder.send` (APPROVE sends ONE governed reminder) — BOTH
 * signature-chase actions, so the existing `signature_requests.*` gates fit
 * exactly (no new permission family needed yet). So:
 *   - GET /proposals    → `signature_requests.read`  (reading proposals == reading
 *                          the signature-chase surface).
 *   - POST …/approve    → `signature_requests.send`  (approving == re-issuing a
 *                          signing link — the send-class capability).
 *   - POST …/reject     → `signature_requests.read`  (a read-class dismissal).
 * The service additionally enforces `requireManager` on every op (defense in
 * depth + the proposals surface is manager-only), and RLS isolates per-org. When
 * future kinds beyond signatures land, a dedicated `proposals.*` permission family
 * should be introduced + mapped — flagged for the next slice. Every handler
 * declares a gate so AuthorizationGuard never fails open by omission.
 */
@Controller('proposals')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  @Get()
  @RequirePermission('signature_requests.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListProposalsQuery)) query: ListProposalsQueryDto,
  ) {
    return this.proposals.list(user, query);
  }

  // Constant-time pending-count for the inbox's HONEST lead line — MIRRORS
  // `GET /notifications/unread-count`. The FE polls this so the "N החלטות
  // ממתינות לך" header states the TRUE total, never the ≤25 page size. The
  // optional `?kind` narrows IDENTICALLY to `list` so the count tracks the active
  // facet (lead-line + honesty-line + feed = one kind-aware source; no "X מתוך Y"
  // drift). Declared as a STATIC `pending-count` segment (no `:id` GET exists on
  // this controller, so no capture conflict). Read-class gate (a count is a
  // read); the service additionally enforces `requireManager`.
  @Get('pending-count')
  @RequirePermission('signature_requests.read')
  async pendingCount(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ProposalPendingCountQuery)) query: ProposalPendingCountQueryDto,
  ) {
    return { data: await this.proposals.pendingCount(user, query) };
  }

  @Post(':id/approve')
  @RequirePermission('signature_requests.send')
  async approve(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.proposals.approve(user, id) };
  }

  @Post(':id/reject')
  @RequirePermission('signature_requests.read')
  async reject(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.proposals.reject(user, id) };
  }
}
