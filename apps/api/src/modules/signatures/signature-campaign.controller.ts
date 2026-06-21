import { SignatureCampaignInput } from '@emapp/shared-types';
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { SignatureRequestsService } from './signature-requests.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/** S5b — SIGNATURE CAMPAIGN. `POST /api/v1/projects/:id/signature-campaign`
 *  fans out ONE project document to ALL active owners of the project. Lives in
 *  the signatures module (next to the service that owns the fan-out logic) but
 *  is mounted under the `projects/:id` path so the FE's project-detail page can
 *  call it. Same coarse permission + the SAME per-route throttle as the bulk
 *  send (`signature_requests.send`, 10/min) — each call can fan out a whole
 *  project's owners, so the throttle prevents an email-bomb. The service owns
 *  project-visibility (no-oracle 404), the doc-belongs-to-project gate, owner
 *  derivation, and the createBulk reuse (#2 gate + #3 dedup + delivery). */
@Controller('projects')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class SignatureCampaignController {
  constructor(private readonly signatureRequests: SignatureRequestsService) {}

  @Post(':id/signature-campaign')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('signature_requests.send')
  async createCampaign(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(SignatureCampaignInput))
    body: SignatureCampaignInput,
  ) {
    return { data: await this.signatureRequests.createCampaign(user, id, body) };
  }

  /** HB-1 — one-tap "remind the project's PENDING signers". The server DERIVES
   *  every LIVE PENDING signature request of the project (status='pending' AND
   *  expires_at > now(), joined ownership → apartment → building → project) and
   *  re-mints + re-delivers each (REUSING the per-request resend path). NO body:
   *  the client supplies neither ownerIds nor a documentId — the recipient scope
   *  is computed server-side and is PENDING-ONLY (a signed owner is never
   *  re-spammed; an expired request is excluded). Same coarse `signature_requests.send`
   *  + fine manage_signatures + agent active-assignment gate as the campaign, the
   *  SAME N15 kill-switch (enforced AFTER authz — no state oracle), and the SAME
   *  30/min throttle as the single-request resend. Idempotency-Key honoured by the
   *  global IdempotencyInterceptor (POST, route-keyed) → a double-submit re-mints
   *  + re-delivers ONCE. Returns { reminded, total }. */
  @Post(':id/signature-requests/remind')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @RequirePermission('signature_requests.send')
  async remindPending(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
  ) {
    return { data: await this.signatureRequests.remindProjectPending(user, id) };
  }
}
