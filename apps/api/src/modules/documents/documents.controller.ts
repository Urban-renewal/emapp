import {
  CreateDocumentInput,
  DownloadDocumentQuery,
  FinalizeDocumentInput,
  ListDocumentsQuery,
  UpdateDocumentInput,
  type CreateDocument,
  type DownloadDocumentQueryDto,
  type FinalizeDocument,
  type ListDocumentsQueryDto,
  type UpdateDocument,
} from '@emapp/shared-types';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { DocumentsService } from './documents.service';
import { safeDownloadFilename } from './storage';

const UuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * 7d — dedicated raw-body ceiling for POST :id/content (50MB, ===
 * DOCUMENT_MAX_SIZE_BYTES). Applied as the Fastify `bodyLimit` of the
 * `application/octet-stream` content-type parser registered in main.ts —
 * this is the ONLY route that accepts that content type, so the parser-level
 * limit is effectively per-route (JSON routes keep Fastify's 1MB default).
 */
export const CONTENT_UPLOAD_BODY_LIMIT_BYTES = 52_428_800;

// Thin controller: guards + Zod only. Engine permission gate (slice-5a
// @RequirePermission) is the coarse layer; the FINE agent gate
// (requireAgentCapability('manage_documents')) + doc/project visibility scoping
// + withTenant + presign-after-authorize stay in the service. r2Key is never
// accepted nor returned. finalize is a document write (POST → documents.create
// cell, matching the legacy verb→action default); download stays a read.
@Controller('documents')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequirePermission('documents.read')
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
  @RequirePermission('documents.create')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateDocumentInput)) body: CreateDocument,
  ) {
    return { data: await this.documents.create(user, body) };
  }

  @Get(':id')
  @RequirePermission('documents.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.documents.get(user, id) };
  }

  @Get(':id/download')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('documents.read')
  async download(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Query(new ZodValidationPipe(DownloadDocumentQuery)) query: DownloadDocumentQueryDto,
    @Res() reply: FastifyReply,
  ) {
    // 7d — bytes_encrypted docs are decrypt-STREAMED by the API (a presigned
    // URL would serve ciphertext); plain docs keep the byte-identical
    // `{ data: { url, expiresInSeconds } }` presign response. All gates
    // (visibility/ghost/scan/PII step-up) run in the service either way.
    const result = await this.documents.resolveDownload(user, id, query.disposition);
    if (result.kind === 'presign') {
      return reply.send({ data: result.data });
    }
    // Same dual-slot Content-Disposition the presign path stamps (RFC 6266
    // ASCII fallback + RFC 5987 UTF-8 for Hebrew names); type per the
    // existing inline/attachment query param.
    const disp =
      `${result.disposition}; filename="${safeDownloadFilename(result.name)}"` +
      `; filename*=UTF-8''${encodeURIComponent(result.name)}`;
    return (
      reply
        .header('content-type', result.mimeType)
        .header('content-disposition', disp)
        .header('content-length', String(result.sizeBytes))
        // SECURITY-UPLOAD-AUDIT.md (secondary) — stop the browser MIME-sniffing
        // the body away from the declared content-type. Defense-in-depth
        // alongside the magic-byte gate: even a spoofed object is served only as
        // its declared type, never re-interpreted as active content.
        .header('x-content-type-options', 'nosniff')
        .send(result.stream)
    );
  }

  // 7d — SENSITIVE content upload: raw bytes through the API (the sensitive
  // create returns `contentUploadPath` instead of a presigned PUT). The body
  // arrives as a Buffer via the application/octet-stream parser registered in
  // main.ts with the dedicated CONTENT_UPLOAD_BODY_LIMIT_BYTES (52_428_800)
  // bodyLimit. Raw bytes are inherently un-Zod-able — the integrity gate
  // (size+sha256 vs the create-declared values) is the validation.
  @Post(':id/content')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('documents.create')
  async uploadContent(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body() body: unknown,
  ) {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      // Wrong/missing content type (the octet-stream parser never ran) or an
      // empty body — a 400 the client can act on. Never echoes the body.
      throw new BadRequestException({ error: { code: 'invalid_content_body' } });
    }
    return { data: await this.documents.uploadContent(user, id, body) };
  }

  @Post(':id/finalize')
  @HttpCode(200)
  @RequirePermission('documents.create')
  async finalize(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(FinalizeDocumentInput)) body: FinalizeDocument,
  ) {
    return { data: await this.documents.finalize(user, id, body) };
  }

  @Patch(':id')
  @RequirePermission('documents.update')
  async update(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(UpdateDocumentInput)) body: UpdateDocument,
  ) {
    return { data: await this.documents.update(user, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('documents.archive')
  async archive(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.documents.archive(user, id);
  }
}
