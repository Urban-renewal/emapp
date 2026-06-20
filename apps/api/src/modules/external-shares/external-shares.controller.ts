import {
  CreateExternalShareInput,
  ExtendExternalShareInput,
  ListExternalSharesQuery,
  UpdateExternalShareInput,
  type CreateExternalShare,
  type ExtendExternalShare,
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
import { TenantScoped } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ExternalSharesService } from './external-shares.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// X-S3 (V13) — external_share grant management (manager-only WRITES, enforced
// in the service via requireManager). Like the contractor `shares` controller,
// the resource is NOT a separately-listed POLICY-matrix permission (an external
// grant is a delivery channel, not a grantable read resource), so the coarse
// gate is @TenantScoped (authenticated org member); the service's requireManager
// is the real write gate. All ops are org-isolated by RLS + the service's
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
  @TenantScoped()
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
  @TenantScoped()
  async revoke(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.externalShares.revoke(user, id);
  }
}
