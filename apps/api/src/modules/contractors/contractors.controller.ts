import {
  CreateContractorInput,
  ListContractorsQuery,
  UpdateContractorInput,
  type CreateContractor,
  type ListContractorsQueryDto,
  type UpdateContractor,
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
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ContractorsService } from './contractors.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

@Controller('contractors')
@AuthzResource('contractors')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ContractorsController {
  constructor(private readonly contractors: ContractorsService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListContractorsQuery)) query: ListContractorsQueryDto,
  ) {
    return this.contractors.list(user, query);
  }

  @Post()
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateContractorInput)) body: CreateContractor,
  ) {
    return { data: await this.contractors.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.contractors.get(user, id) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateContractorInput)) body: UpdateContractor,
  ) {
    return { data: await this.contractors.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.contractors.archive(user, id);
  }
}
