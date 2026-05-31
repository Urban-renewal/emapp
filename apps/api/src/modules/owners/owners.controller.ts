import { ListOwnersQuery, type ListOwnersQueryDto } from '@emapp/shared-types';
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
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzAction, AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import {
  CreateOwnerDto,
  OwnerSearchDto,
  UpdateOwnerDto,
  type CreateOwner,
  type OwnerSearch,
  type UpdateOwner,
} from './owner.dto';
import { OwnersService } from './owners.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Authz (D.17) + withTenant + all PII
// handling live in the service. Owner LOOKUP is POST /owners/search with
// the PII in the BODY (never the URL) so it cannot leak into access logs.
@Controller('owners')
@AuthzResource('owners')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OwnersController {
  constructor(private readonly owners: OwnersService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListOwnersQuery)) query: ListOwnersQueryDto,
  ) {
    return this.owners.list(user, query);
  }

  // Audit L-2 fix — per-route throttle on /owners/search.
  // Search is a hash-comparison lookup (national_id_hash / phone_hash),
  // so an attacker with a stolen cookie can iterate hash space against
  // it at 100/min under the global budget. Each call returns up to 50
  // masked owners. Not a direct PII leak (masked + hash-equality only
  // finds exact matches), but a meaningful db-load amplifier. 20/min
  // mirrors the documents-post bucket; legitimate UX is one click.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('search')
  @HttpCode(200)
  @AuthzAction('read') // a lookup, not a write — any org role
  async search(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(OwnerSearchDto)) body: OwnerSearch,
  ) {
    return { data: await this.owners.search(user, body) };
  }

  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateOwnerDto)) body: CreateOwner,
  ) {
    return { data: await this.owners.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.owners.get(user, id) };
  }

  // D.54 — reveal-on-demand cleartext PII for ONE owner. POST (not GET) so the
  // owner id + result never land in access logs / browser history, and so it is
  // a deliberate per-owner action (audited, ISO A.12.4). `read` coarse action
  // (any org role passes the matrix); the fine `view_owner_pii` gate + scope +
  // audit live in the service. Throttled like /search — reveal is sensitive and
  // legitimate UX is one click per owner.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/reveal-pii')
  @HttpCode(200)
  @AuthzAction('read')
  async revealPii(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.owners.revealPii(user, id) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateOwnerDto)) body: UpdateOwner,
  ) {
    return { data: await this.owners.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.owners.archive(user, id);
  }
}
