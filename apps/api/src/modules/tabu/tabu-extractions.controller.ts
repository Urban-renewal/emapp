import {
  CreateTabuExtractionInput,
  ListOwnershipsQuery,
  UpdateTabuExtractionRowInput,
  type CreateTabuExtraction,
  type ListOwnershipsQueryDto,
  type UpdateTabuExtractionRow,
} from '@emapp/shared-types';
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { TabuExtractionsService } from './tabu-extractions.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Tabu extractions are apartment-attached
// (S7a "Tabu extraction envelope + lifecycle"), so they reuse the apartments
// permission gate — read = `apartments.read`, create (a WRITE) =
// `apartments.update` (the project/apartment write permission). The fine agent
// gate (requireAgentCapability('edit_project_data')) + via-parent assigned-
// project scoping + the finalized/apartment-scope source-doc checks + withTenant
// all stay in the service. List/create are nested under the apartment; getOne is
// by extraction id. The cursor query reuses `ListOwnershipsQuery` (limit +
// cursor — identical shape, no new schema).
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class TabuExtractionsController {
  constructor(private readonly tabu: TabuExtractionsService) {}

  @Get('apartments/:apartmentId/tabu-extractions')
  @RequirePermission('apartments.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.tabu.list(user, apartmentId, query);
  }

  @Post('apartments/:apartmentId/tabu-extractions')
  @RequirePermission('apartments.update')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Body(new ZodValidationPipe(CreateTabuExtractionInput)) body: CreateTabuExtraction,
  ) {
    return { data: await this.tabu.create(user, apartmentId, body) };
  }

  @Get('tabu-extractions/:id')
  @RequirePermission('apartments.read')
  async getOne(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tabu.getOne(user, id) };
  }

  // 7b-extract — RUN the pluggable extraction engine on a DRAFT extraction:
  // parse the source נסח → ENCRYPT + store owner/share rows. A WRITE (the fine
  // agent gate requireAgentCapability('edit_project_data') + draft-only +
  // source-doc load all stay in the service), so it reuses `apartments.update`.
  @Post('tabu-extractions/:id/extract')
  @RequirePermission('apartments.update')
  async extract(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tabu.runExtraction(user, id) };
  }

  // 7c — the DECRYPTED parsed rows for the review screen. A READ, so
  // `apartments.read` — but the service additionally requires a VALID
  // per-session PII unlock (403 pii_step_up_required) and applies the D.54
  // role-fidelity masking to national_id.
  @Get('tabu-extractions/:id/rows')
  @RequirePermission('apartments.read')
  async listRows(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tabu.listRows(user, id) };
  }

  // 7c — edit one parsed row before confirm (re-encrypts PII, edited=true).
  // A WRITE: `apartments.update` + the service-level unlock gate + the D.54
  // fine agent gate (edit_project_data) + draft-only.
  @Patch('tabu-extractions/:id/rows/:rowId')
  @RequirePermission('apartments.update')
  async updateRow(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Param('rowId', UuidParam) rowId: string,
    @Body(new ZodValidationPipe(UpdateTabuExtractionRowInput)) body: UpdateTabuExtractionRow,
  ) {
    await this.tabu.updateRow(user, id, rowId, body);
    return { data: { ok: true } };
  }

  // 7c — THE commit: audit-first, idempotent (WHERE status='draft' → 409 on
  // a second confirm), atomic owners-match/create + ownership replace with
  // provenance. Same gates as updateRow. No body.
  @Post('tabu-extractions/:id/confirm')
  @RequirePermission('apartments.update')
  async confirm(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.tabu.confirm(user, id) };
  }
}
