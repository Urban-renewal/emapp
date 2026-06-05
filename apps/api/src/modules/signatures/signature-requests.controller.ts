import {
  CreateSignatureRequestInput,
  ListSignatureRequestsQuery,
  type CreateSignatureRequest,
  type ListSignatureRequestsQueryDto,
} from '@emapp/shared-types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { SignatureRequestsService } from './signature-requests.service';
import { SignedDocumentService } from './signed-document.service';

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
  constructor(
    private readonly signatureRequests: SignatureRequestsService,
    private readonly signedDocuments: SignedDocumentService,
  ) {}

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

  /** Download the SIGNED ARTIFACT — a generated signature-certificate PDF
   *  (signer + document hash + signed-at + the rendered signature). Only a
   *  SIGNED request has one; otherwise the service throws 404. Returns the
   *  PDF binary directly (not the {data} envelope) via the Fastify reply.
   *
   *  Gate = `owners.reveal_pii` (NOT `signature_requests.read`): the artifact
   *  contains decrypted owner PII (the signer's name + their signature image),
   *  so it must require the SAME permission as revealing owner PII — else a
   *  Viewer / Contractor / agent-without-reveal_pii (all of whom hold
   *  signature_requests.read) could export cleartext PII they cannot see on
   *  screen (D.47 / D.50). The service additionally reuses the SR read path
   *  for the agent record-scope (assigned-project) visibility check. */
  @Get(':id/signed-document')
  @RequirePermission('owners.reveal_pii')
  async signedDocument(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { pdf, fileName } = await this.signedDocuments.generate(user, id);
    await reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Content-Length', String(pdf.length))
      .header('Cache-Control', 'no-store')
      .send(Buffer.from(pdf));
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
