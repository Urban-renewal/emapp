import {
  ListOwnersQuery,
  OwnerNameSearchQuery,
  type ListOwnersQueryDto,
  type OwnerNameSearchQueryDto,
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
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { OwnerEraseDto, type OwnerEraseBody } from './data-subject.dto';
import { DataSubjectService } from './data-subject.service';
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

// Thin controller: guards + Zod only. Engine permission gate
// (slice-5a @RequirePermission) is the coarse layer; the FINE owner gates
// (canViewOwners / view_owner_pii fidelity / edit_project_data + the ownership
// project-scope join) + withTenant + all PII handling live in the service.
// Owner LOOKUP is POST /owners/search with the PII in the BODY (never the URL)
// so it cannot leak into access logs — but it is semantically a READ
// (`owners.read`), as is the per-owner reveal-pii (the cleartext gate is the
// service's `view_owner_pii`, NOT a separate coarse permission).
@Controller('owners')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class OwnersController {
  constructor(
    private readonly owners: OwnersService,
    private readonly dataSubject: DataSubjectService,
  ) {}

  @Get()
  @RequirePermission('owners.read')
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
  @RequirePermission('owners.read') // a lookup, not a write — owners.read coarse gate
  async search(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(OwnerSearchDto)) body: OwnerSearch,
  ) {
    return { data: await this.owners.search(user, body) };
  }

  // NS1 (server-side search) — owner NAME substring search, keyset-paginated.
  // GET (not the POST by-PII search above): `q` is a NAME (not PII national_id/
  // phone), so it is safe in the query string — it never leaks a national_id or
  // phone into access logs. Returns the SAME masked-PII projection as the list
  // endpoint ({data, page}); national_id/phone ALWAYS masked. Same coarse
  // `owners.read` gate; the FINE view_owners + agent scope live in the service.
  // Throttled like the other owner-search surfaces (one click of legit UX).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('search')
  @RequirePermission('owners.read')
  async searchByName(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(OwnerNameSearchQuery)) query: OwnerNameSearchQueryDto,
  ) {
    return this.owners.searchByName(user, query);
  }

  @Post()
  @RequirePermission('owners.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateOwnerDto)) body: CreateOwner,
  ) {
    return { data: await this.owners.create(user, body) };
  }

  @Get(':id')
  @RequirePermission('owners.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.owners.get(user, id) };
  }

  // S3d — owner → projects surfacing. The DISTINCT projects the owner is tied to
  // via active ownerships (owner → ownerships → apartments → buildings →
  // projects). Coarse gate `owners.read` (mirrors the owner detail surface); the
  // FINE view_owners gate + org/agent project-scope live in the service. Returns
  // a lean PROJECT list ({data}) — NO owner PII.
  @Get(':id/projects')
  @RequirePermission('owners.read')
  async listProjects(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return this.owners.listProjects(user, id);
  }

  // D.54 — reveal-on-demand cleartext PII for ONE owner. POST (not GET) so the
  // owner id + result never land in access logs / browser history, and so it is
  // a deliberate per-owner action (audited, ISO A.12.4). The COARSE gate is
  // `owners.read` (everyone who can see owners reaches here); the FINE
  // `view_owner_pii` fidelity gate + scope + audit live in the service.
  // Throttled like /search — reveal is sensitive and legitimate UX is one click.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/reveal-pii')
  @HttpCode(200)
  @RequirePermission('owners.read')
  async revealPii(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.owners.revealPii(user, id) };
  }

  // P0.C1 — data-subject RIGHT TO ACCESS. GET (no body) but the response carries
  // CLEARTEXT PII; the owner id in the URL is an opaque UUID (no PII leak to
  // access logs). Coarse gate `owners.reveal_pii` (the dedicated cleartext-access
  // permission); the service re-asserts MANAGER-tier + audits as a reveal.
  // Throttled like reveal — a deliberate per-owner compliance action.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':id/data-export')
  @RequirePermission('owners.reveal_pii')
  async dataExport(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.dataSubject.dataExport(user, id) };
  }

  // P0.C1 — data-subject RIGHT-TO-BE-FORGOTTEN (erasure). POST (state change),
  // 200 with the erasure result. Manager-gated (service re-asserts), audited,
  // Gate-6. IRREVERSIBLE crypto-shred (anonymize-in-place; signatures retained).
  // IDEMPOTENT (re-erase = no-op). Throttled — a deliberate destructive action.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/erase')
  @HttpCode(200)
  @RequirePermission('owners.reveal_pii')
  async erase(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(OwnerEraseDto)) body: OwnerEraseBody,
  ) {
    return { data: await this.dataSubject.erase(user, id, body) };
  }

  @Patch(':id')
  @RequirePermission('owners.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateOwnerDto)) body: UpdateOwner,
  ) {
    return { data: await this.owners.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('owners.archive')
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.owners.archive(user, id);
  }
}
