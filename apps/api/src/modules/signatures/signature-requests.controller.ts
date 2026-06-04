import {
  CreateSignatureRequestInput,
  ListSignatureRequestsQuery,
  type CreateSignatureRequest,
  type ListSignatureRequestsQueryDto,
} from '@emapp/shared-types';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
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

// Thin controller: guards + Zod only. Engine permission gate (slice-5a
// @RequirePermission) is the coarse layer; the FINE agent gate
// (requireAgentCapability('manage_signatures')) + underlying-document
// visibility + withTenant + IDOR defense stay in the service. The signing JWT
// (a bearer credential) is server-minted, ONLY returned embedded in `signUrl`
// — never accepted as input. create → `send`; cancel → `cancel` (legacy
// create / update(cancel) cells map to the catalog's send / cancel).
@Controller('signature-requests')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class SignatureRequestsController {
  constructor(private readonly signatureRequests: SignatureRequestsService) {}

  @Get()
  @RequirePermission('signature_requests.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListSignatureRequestsQuery))
    query: ListSignatureRequestsQueryDto,
  ) {
    return this.signatureRequests.list(user, query);
  }

  // Tighter throttle than the global 100/min — creating a signature
  // request emails the resident + reserves a 7-day token, so even a
  // legitimate manager should not be able to spam. Same posture as
  // documents POST.
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('signature_requests.send')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateSignatureRequestInput))
    body: CreateSignatureRequest,
  ) {
    return { data: await this.signatureRequests.create(user, body) };
  }

  @Get(':id')
  @RequirePermission('signature_requests.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.signatureRequests.get(user, id) };
  }

  /** Cancel = state transition (pending → cancelled). D.46: manager OR an agent
   *  holding `manage_signatures` on the request's document (assigned project);
   *  viewer is excluded. The fine gate lives in the service. Coarse gate =
   *  `signature_requests.cancel` (legacy update/delete cells both map here). */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('signature_requests.cancel')
  async cancel(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.signatureRequests.cancel(user, id) };
  }
}
