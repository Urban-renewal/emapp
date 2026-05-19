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
