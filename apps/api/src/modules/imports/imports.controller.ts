/**
 * Imports controller — Phase 6 S2 read surface + S8 write surface.
 *
 * Endpoints:
 *   GET    /imports/:id           → status snapshot (D.17 read=ALL)
 *   GET    /imports/:id/stream    → SSE progress stream (T6.9)
 *   POST   /imports               → create + presigned PUT URL (S8)
 *   POST   /imports/:id/start     → enqueue pg-boss job (S8)
 *   DELETE /imports/:id           → cancel non-terminal row (S8)
 *   GET    /imports/:id/errors    → paginated import_job_errors (S8)
 *   POST   /imports/:id/mapping   → D.34 wizard (S8)
 *
 * Defense-in-depth (same chain as documents/signature_requests):
 *   AuthGuard → TenantGuard → AuthorizationGuard (verb→action, policy
 *   `imports`) → service `requireManager` → withTenant (RLS FORCE
 *   org-isolation) → service business-rule guards (state-machine
 *   gates).
 */
import {
  CreateImportInput,
  ListImportErrorsQuery,
  StartImportInput,
  SubmitMappingInput,
  type CreateImport,
  type ListImportErrorsQueryDto,
  type StartImport,
  type SubmitMapping,
} from '@emapp/shared-types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { encodeSseFrame, ImportsService } from './imports.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

@Controller('imports')
@AuthzResource('imports')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ImportsController {
  private readonly logger = new Logger(ImportsController.name);

  constructor(private readonly imports: ImportsService) {}

  // POST /imports — create row + presigned PUT.
  // Tighter per-route throttle than the global 100/min — uploads are
  // expensive (R2 round-trip + audit + presign) and a malicious or
  // misbehaving client shouldn't blast the API. Matches the documents
  // POST/download throttle (30/min).
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateImportInput)) body: CreateImport,
  ) {
    return { data: await this.imports.create(user, body) };
  }

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.imports.get(user, id) };
  }

  // POST /imports/:id/start — enqueue the worker job. Same throttle
  // class as create (cheap on the API but kicks off heavy worker
  // work; a runaway client could DoS the worker pool).
  @Post(':id/start')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  async start(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(StartImportInput)) _body: StartImport,
  ) {
    void _body;
    return { data: await this.imports.start(user, id) };
  }

  // DELETE /imports/:id — cancel. 204 (no body) on success; the FE
  // re-fetches via GET /imports/:id to render the new terminal state.
  @Delete(':id')
  @HttpCode(204)
  async cancel(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.imports.cancel(user, id);
  }

  @Get(':id/errors')
  async listErrors(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Query(new ZodValidationPipe(ListImportErrorsQuery)) query: ListImportErrorsQueryDto,
  ) {
    // The service returns { data, page } directly — match the list-
    // envelope convention (D.16). Wrap is already correct shape.
    return this.imports.listErrors(user, id, query);
  }

  // POST /imports/:id/mapping — D.34 wizard endpoint. Same tight
  // throttle as the other mutation endpoints.
  @Post(':id/mapping')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  async submitMapping(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(SubmitMappingInput)) body: SubmitMapping,
  ) {
    return { data: await this.imports.submitMapping(user, id, body) };
  }

  /** SSE progress stream. See file header for full explanation. */
  @Get(':id/stream')
  async stream(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    reply.raw.write(': stream-open\n\n');

    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());

    try {
      await this.imports.streamProgress({
        user,
        id,
        write: (ev) => reply.raw.write(encodeSseFrame(ev)),
        writeComment: (line) => reply.raw.write(`${line}\n\n`),
        signal: abort.signal,
      });
    } catch (e: unknown) {
      this.logger.error(
        `SSE stream errored after headers-sent (import=${id}): ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
      try {
        reply.raw.write(encodeSseFrame({ event: 'end', data: { id, status: 'failed' } }));
      } catch {
        /* socket already dead */
      }
    } finally {
      reply.raw.end();
    }
  }
}
