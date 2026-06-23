import {
  BulkCreateSignatureRequestInput,
  CreateSignatureRequestInput,
  ListSignatureRequestsQuery,
  type BulkCreateSignatureRequest,
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

  /** List signature requests (keyset-paginated). Slice-2: the validated query
   *  carries the optional `projectId` filter (scopes the flat list to one
   *  project; honors agent record-scoping in the service) alongside the existing
   *  status/documentId/ownerId filters; the service returns enriched
   *  `SignatureRequestListItem` rows (display context + masked-default owner
   *  name behind view_owner_pii). The ZodValidationPipe rejects any unknown
   *  query key (`.strict()`), so no raw query access. */
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

  /** Bulk send — ONE document to MANY owners in a single action. Same coarse
   *  permission + fine capability gate as create() (the service gates once for
   *  the whole batch). Lower throttle limit than single-create because each
   *  call fans out up to 200 requests + deliveries. */
  @Post('bulk')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('signature_requests.send')
  async createBulk(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(BulkCreateSignatureRequestInput))
    body: BulkCreateSignatureRequest,
  ) {
    return { data: await this.signatureRequests.createBulk(user, body) };
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
   *  Coarse gate = `owners.read`; the FINE PII gate (`resolveOwnerPiiFidelity
   *  === 'unmasked'` — manager always · agent iff `view_owner_pii` capability ·
   *  viewer never) lives in the service, EXACTLY mirroring POST
   *  /owners/:id/reveal-pii. The artifact carries decrypted owner PII (signer
   *  name + signature), so its gate must match the on-screen PII-reveal gate —
   *  NOT engine `owners.reveal_pii`, which excludes a capability-granted agent
   *  (the split-brain we removed). The service also reuses the SR read path for
   *  the agent record-scope (assigned-project) visibility check. Content-type
   *  comes from the renderer (the artifact may not always be a PDF). */
  @Get(':id/signed-document')
  @RequirePermission('owners.read')
  async signedDocument(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { bytes, contentType, fileName } = await this.signedDocuments.generate(user, id);
    await reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Content-Length', String(bytes.length))
      .header('Cache-Control', 'no-store')
      .send(Buffer.from(bytes));
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

  /** Resend / remind — refresh a PENDING request's link (new token + 7-day
   *  expiry) and re-deliver. Same coarse `signature_requests.send` + fine
   *  manage_signatures gate as create (the service enforces both). */
  @Post(':id/resend')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @RequirePermission('signature_requests.send')
  async resend(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.signatureRequests.resend(user, id) };
  }

  /** Retrieve the signing link for a PENDING request, to deliver OUT-OF-BAND
   *  (P4 — the phone-less owner who can't be SMS'd and can't self-serve the
   *  SMS-OTP portal). Re-mints a fresh token (prior link dies) and returns
   *  { request, signUrl } with NO delivery. The signUrl is a BEARER credential,
   *  so the gate matches the SEND path — coarse `signature_requests.send` here +
   *  the fine manage_signatures capability in the service — NOT `.read` (a
   *  Viewer must not be able to pull the credential). POST because it mutates
   *  (re-mints jti); throttled like resend. */
  @Post(':id/link')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @RequirePermission('signature_requests.send')
  async getLink(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.signatureRequests.getLink(user, id) };
  }
}
