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
import { AuthzAction, AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { SignatureRequestsService } from './signature-requests.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. D.17 (manager-only writes, ALL
// roles read with agent record-scoping in the service) + withTenant +
// IDOR defense all live in the service. The signing JWT (a bearer
// credential) is server-minted and ONLY returned embedded in `signUrl`
// — never accepted as input.
@Controller('signature-requests')
@AuthzResource('signature_requests')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class SignatureRequestsController {
  constructor(private readonly signatureRequests: SignatureRequestsService) {}

  @Get()
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
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateSignatureRequestInput))
    body: CreateSignatureRequest,
  ) {
    return { data: await this.signatureRequests.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.signatureRequests.get(user, id) };
  }

  /** Cancel = state transition (pending → cancelled). Annotated as
   *  `update` for the D.17 policy matrix (manager-only — viewer/agent
   *  must NOT be able to cancel a request). */
  @Post(':id/cancel')
  @HttpCode(200)
  @AuthzAction('update')
  async cancel(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.signatureRequests.cancel(user, id) };
  }
}
