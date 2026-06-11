import {
  CreateDiscoveryRecordInput,
  ListOwnershipsQuery,
  UpdateDiscoveryRecordInput,
  type CreateDiscoveryRecord,
  type ListOwnershipsQueryDto,
  type UpdateDiscoveryRecord,
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

import { DiscoveryService } from './discovery.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. Discovery records are apartment-attached
// (S3c "renter → discovery-source"), so they reuse the apartments permission
// gate — read = `apartments.read`, write = `apartments.update` (the
// project/apartment write permission). The fine agent gate
// (requireAgentCapability('edit_project_data')) + via-parent assigned-project
// scoping + withTenant stay in the service. List/create are nested under the
// apartment; update is by record id. The cursor query reuses
// `ListOwnershipsQuery` (limit + cursor — identical shape, no new schema).
@Controller()
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('apartments/:apartmentId/discovery-records')
  @RequirePermission('apartments.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Query(new ZodValidationPipe(ListOwnershipsQuery)) query: ListOwnershipsQueryDto,
  ) {
    return this.discovery.list(user, apartmentId, query);
  }

  @Post('apartments/:apartmentId/discovery-records')
  @RequirePermission('apartments.update')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Param('apartmentId', UuidParam) apartmentId: string,
    @Body(new ZodValidationPipe(CreateDiscoveryRecordInput)) body: CreateDiscoveryRecord,
  ) {
    return { data: await this.discovery.create(user, apartmentId, body) };
  }

  @Patch('discovery-records/:id')
  @RequirePermission('apartments.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateDiscoveryRecordInput)) body: UpdateDiscoveryRecord,
  ) {
    return { data: await this.discovery.update(user, id, body) };
  }
}
