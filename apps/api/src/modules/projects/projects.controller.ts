import {
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
  type CreateProject,
  type ListProjectsQueryDto,
  type UpdateProject,
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
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ProjectsService } from './projects.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards (auth + tenant) + Zod validation only. Authorization
// is the engine permission gate (slice-5a @RequirePermission, resolved by
// AuthorizationGuard); record-scoping (agent → assigned project) + data access
// (withTenant) live in the service. Every route is /api/v1/projects (D.10).
@Controller('projects')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission('projects.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListProjectsQuery)) query: ListProjectsQueryDto,
  ) {
    return this.projects.list(user, query);
  }

  @Get(':id')
  @RequirePermission('projects.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.projects.get(user, id) };
  }

  // Phase-6 "תמונת מצב" — project signature-progress board (read-only). Same
  // guards + permission as GET :id; the service owns visibility (no-oracle 404
  // for cross-org / unassigned-agent) and the aggregate compute. The more
  // specific two-segment path is registered alongside `:id` with no conflict.
  @Get(':id/signature-progress')
  @RequirePermission('projects.read')
  async signatureProgress(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
  ) {
    return { data: await this.projects.signatureProgress(user, id) };
  }

  // Phase-6 "תמונת מצב" — per-apartment DRILL-DOWN (S5d, read-only). Same guards
  // + permission as the 5a board; the service owns visibility (no-oracle 404) and
  // the per-apartment compute. Returns a LIST under `data`; NO owner PII (only
  // apartment designation + counts + derived status).
  @Get(':id/signature-progress/apartments')
  @RequirePermission('projects.read')
  async signatureProgressApartments(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
  ) {
    return { data: await this.projects.signatureProgressApartments(user, id) };
  }

  // E2 Wave-2 B4 — apartment HOLDOUTS ("מי תקוע / who's stuck"): the NAMED list of
  // the apartment's active owners who have NOT signed. The COARSE gate is
  // `projects.read` (everyone who can see the board reaches here); the FINE
  // `view_owner_pii` capability gate + project/apartment visibility (no-oracle
  // 404) + the per-access AUDIT live in the service. This is the ONLY
  // signature-progress surface that returns owner NAMES — it mirrors the owners
  // reveal-pii pattern (capability-gated + audited). Returns ownerId + name +
  // apartmentNumber ONLY under `data.holdouts`; NEVER national_id/phone.
  @Get(':id/signature-progress/apartments/:apartmentId/holdouts')
  @RequirePermission('projects.read')
  async signatureProgressHoldouts(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Param('apartmentId', UuidParam) apartmentId: string,
  ) {
    return {
      data: { holdouts: await this.projects.signatureProgressHoldouts(user, id, apartmentId) },
    };
  }

  // Battle-Map BM-1 — the LEVERAGE scorer: the single not-yet-fully-signed owner
  // whose signature moves the project's headline share-weighted consent % the
  // MOST toward target (ranked by marginal-delta-to-headline, NOT share-sum). The
  // COARSE gate is `projects.read` (everyone who sees the board reaches here); the
  // service owns visibility (no-oracle 404) and the FINE `view_owner_pii` name
  // FIDELITY downgrade (name-or-no-name — never a 403). Returns the leverage owner
  // (apartment + delta) under `data`; `data.leverage` is null when none movable.
  @Get(':id/leverage')
  @RequirePermission('projects.read')
  async leverage(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.projects.leverage(user, id) };
  }

  @Post()
  @RequirePermission('projects.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateProjectInput)) body: CreateProject,
  ) {
    return { data: await this.projects.create(user, body) };
  }

  @Patch(':id')
  @RequirePermission('projects.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateProjectInput)) body: UpdateProject,
  ) {
    return { data: await this.projects.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('projects.archive')
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.projects.archive(user, id);
  }
}
