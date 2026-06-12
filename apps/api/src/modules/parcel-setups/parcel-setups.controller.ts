import {
  CreateParcelSetupInput,
  ListOwnershipsQuery,
  UpdateParcelSetupPayloadInput,
  type CreateParcelSetup,
  type ListOwnershipsQueryDto,
  type UpdateParcelSetupPayload,
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

import { ParcelSetupsService } from './parcel-setups.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Parcel setups are PROJECT-attached
// (P3a "parcel-setup envelope + manual path → skeleton") and their confirm
// materializes buildings + apartments, so they reuse the buildings permission
// gate — read = `buildings.read`, writes = `buildings.create`/`buildings.update`
// (the coarse cells D.46 opened to agents). The FINE agent gate
// (requireAgentCapability('edit_project_data'), D.54) + the project-visibility
// no-oracle 404 + the STRICT no-PII payload re-parse + withTenant all stay in
// the service. List/create are nested under the project; getOne/patch/confirm
// are by setup id. The cursor query reuses `ListOwnershipsQuery` (limit +
// cursor — identical shape, no new schema).
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ParcelSetupsController {
  constructor(private readonly parcelSetups: ParcelSetupsService) {}

  @Post('projects/:projectId/parcel-setups')
  @RequirePermission('buildings.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Body(new ZodValidationPipe(CreateParcelSetupInput)) body: CreateParcelSetup,
  ) {
    return { data: await this.parcelSetups.create(user, projectId, body) };
  }

  @Get('projects/:projectId/parcel-setups')
  @RequirePermission('buildings.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('projectId', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.parcelSetups.list(user, projectId, query);
  }

  @Get('parcel-setups/:id')
  @RequirePermission('buildings.read')
  async getOne(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.parcelSetups.getOne(user, id) };
  }

  // Save the draft buildings/apartments JSON. DRAFT-only (409). The service
  // RE-parses body.payload with the STRICT no-PII schema (defense-in-depth).
  @Patch('parcel-setups/:id')
  @RequirePermission('buildings.update')
  async updatePayload(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateParcelSetupPayloadInput)) body: UpdateParcelSetupPayload,
  ) {
    return { data: await this.parcelSetups.updatePayload(user, id, body.payload) };
  }

  // THE manual-path commit: audit-first (ids+counts only), IDEMPOTENT
  // single-claim (WHERE status='draft' → 409 on a second confirm), ATOMIC
  // skeleton creation with provenance; collision with the existing skeleton
  // → clean 409 parcel_skeleton_conflict, FULL rollback. No body.
  @Post('parcel-setups/:id/confirm')
  @RequirePermission('buildings.create')
  async confirm(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.parcelSetups.confirm(user, id) };
  }
}
