import {
  CreateDocumentInput,
  FinalizeDocumentInput,
  ListDocumentsQuery,
  UpdateDocumentInput,
  type CreateDocument,
  type FinalizeDocument,
  type ListDocumentsQueryDto,
  type UpdateDocument,
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
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { DocumentsService } from './documents.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

// Thin controller: guards + Zod only. D.17 (manager write / any-role read,
// agent record-scoped) + withTenant + presign-after-authorize all live in
// the service. r2Key is never accepted nor returned.
@Controller('documents')
@AuthzResource('documents')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListDocumentsQuery)) query: ListDocumentsQueryDto,
  ) {
    return this.documents.list(user, query);
  }

  // Tighter per-route limits than the global 100/min (review item 8 —
  // confidential-doc bulk-exfil / row-spam defense). The contract suite's
  // x-throttle-bypass still skips these in CI.
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateDocumentInput)) body: CreateDocument,
  ) {
    return { data: await this.documents.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.documents.get(user, id) };
  }

  @Get(':id/download')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async download(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.documents.getDownloadUrl(user, id) };
  }

  @Post(':id/finalize')
  @HttpCode(200)
  async finalize(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(FinalizeDocumentInput)) body: FinalizeDocument,
  ) {
    return { data: await this.documents.finalize(user, id, body) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateDocumentInput)) body: UpdateDocument,
  ) {
    return { data: await this.documents.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.documents.archive(user, id);
  }
}
