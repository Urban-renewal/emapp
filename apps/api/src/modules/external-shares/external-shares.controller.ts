import {
  CreateExternalShareInput,
  ExtendExternalShareInput,
  ExternalPartyAccessQuery,
  ListExternalSharesQuery,
  UpdateExternalShareInput,
  type CreateExternalShare,
  type ExtendExternalShare,
  type ExternalPartyAccessQueryDto,
  type ListExternalSharesQueryDto,
  type UpdateExternalShare,
} from '@emapp/shared-types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission, TenantScoped } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ExternalSharesService } from './external-shares.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// X-S3 (V13) — external_share grant management (manager-only WRITES, enforced
// in the service via requireManager). Mirrors the contractor `shares` controller
// convention: the permission catalog models shares as create + revoke ONLY
// (`shares.create` / `shares.revoke`) — there is no `shares.read` /
// `shares.update` / extend / resend permission (a share is a delivery channel,
// not a separately-listed read resource, and there is no in-place edit — you
// revoke + re-issue). So create + revoke carry the real coarse permission
// (`@RequirePermission`), and list / update / extend / resend carry
// @TenantScoped (NO_ENGINE_EQUIVALENT — authenticated org member). The service's
// requireManager keeps EVERY write manager-only regardless of the coarse gate,
// so the equivalence-map "Agent gains shares.create/revoke" coarse divergence is
// NOT an effective widening here (an agent past the coarse gate still 403s at
// the service). The decorators are defense-in-depth: no new method can ship
// ungated by omission (AuthorizationGuard fails closed on a handler that
// declares neither). All ops are org-isolated by RLS + the service's
// suspended-org / no-oracle 404 posture.
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ExternalSharesController {
  constructor(private readonly externalShares: ExternalSharesService) {}

  @Get('external-shares')
  @TenantScoped()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListExternalSharesQuery)) query: ListExternalSharesQueryDto,
  ) {
    return this.externalShares.list(user, query);
  }

  @Post('external-shares')
  @RequirePermission('shares.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateExternalShareInput)) body: CreateExternalShare,
  ) {
    return { data: await this.externalShares.create(user, body) };
  }

  @Patch('external-shares/:id')
  @TenantScoped()
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateExternalShareInput)) body: UpdateExternalShare,
  ) {
    return { data: await this.externalShares.update(user, id, body) };
  }

  // SEC-H1 — the party-share document-retrieval AUTHZ resolution surface. Given
  // a grant + a document, returns the FAIL-CLOSED allow/deny decision + serve
  // constraints produced by the ONE shared resolver consuming `external_shares`
  // (expiry / revocation / scope / allow_sensitive / OTP / watermark). This is
  // the enforcement the "invite a party" FE (UX-slice-4) depends on existing.
  // Read-only org-member surface (@TenantScoped); the party-token (X-S4) tier
  // will call the SAME `resolveDocumentAccess` once it lands.
  @Get('external-shares/:id/documents/:documentId/access')
  @TenantScoped()
  async resolveDocumentAccess(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Param('documentId', UuidParam) documentId: string,
    @Query(new ZodValidationPipe(ExternalPartyAccessQuery)) query: ExternalPartyAccessQueryDto,
  ) {
    return {
      data: await this.externalShares.resolveDocumentAccess(user, id, documentId, {
        otpVerified: query.otpVerified,
      }),
    };
  }

  @Post('external-shares/:id/extend')
  @TenantScoped()
  async extend(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(ExtendExternalShareInput)) body: ExtendExternalShare,
  ) {
    return { data: await this.externalShares.extend(user, id, body) };
  }

  @Post('external-shares/:id/resend')
  @TenantScoped()
  async resend(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.externalShares.resend(user, id) };
  }

  @Delete('external-shares/:id')
  @HttpCode(204)
  @RequirePermission('shares.revoke')
  async revoke(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.externalShares.revoke(user, id);
  }
}
