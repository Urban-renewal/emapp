import { CreateSignatureRequestInput, type CreateSignatureRequest } from '@emapp/shared-types';
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { SignatureRequestsService } from './signature-requests.service';

// Thin controller: guards + Zod only. D.17 (manager-only writes) +
// withTenant + IDOR defense all live in the service. The signing JWT
// (a bearer credential) is server-minted and ONLY returned embedded in
// `signUrl` — never accepted as input.
@Controller('signature-requests')
@AuthzResource('signature_requests')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class SignatureRequestsController {
  constructor(private readonly signatureRequests: SignatureRequestsService) {}

  // Tighter throttle than the global 100/min — creating a signature
  // request emails the resident + reserves a 7-day token, so even a
  // legitimate manager should not be able to spam. Same posture as
  // documents POST.
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateSignatureRequestInput)) body: CreateSignatureRequest,
  ) {
    return { data: await this.signatureRequests.create(user, body) };
  }
}
