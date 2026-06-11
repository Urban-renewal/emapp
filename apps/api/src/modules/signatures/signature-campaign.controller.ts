import { SignatureCampaignInput } from '@emapp/shared-types';
import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
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
}
