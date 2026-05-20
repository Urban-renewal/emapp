/**
 * Imports controller — Phase 6 S2.
 *
 * Endpoints (S2 scope):
 *   - GET /imports/:id          → status snapshot (D.17 read=ALL roles)
 *   - GET /imports/:id/stream   → SSE progress stream (T6.9)
 *
 * S8 adds: POST /imports (enqueue), GET /imports (list),
 * DELETE :id (cancel), GET :id/errors (errors export).
 *
 * Defense-in-depth (same chain as documents/signature_requests):
 *   AuthGuard → TenantGuard → AuthorizationGuard (verb→action, policy
 *   `imports`) → service `withTenant` (RLS FORCE org-isolation).
 */
import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
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
  constructor(private readonly imports: ImportsService) {}

  @Get(':id')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.imports.get(user, id) };
  }

  /** SSE progress stream. Bypasses Nest's serialiser by writing to
   *  `reply.raw` directly (the standard Fastify SSE pattern). Headers:
   *    Content-Type: text/event-stream — browsers/EventSource expect it.
   *    Cache-Control: no-cache + no-transform — disable any proxy
   *      buffering or content rewriting that would batch our frames.
   *    X-Accel-Buffering: no — nginx-style hint for the same reason.
   *    Connection: keep-alive — long-lived stream.
   *
   *  Disconnection: we hook `req.raw.on('close')` to fire an
   *  AbortController; the service polls cooperatively against the
   *  signal so a closed connection ends the loop immediately. */
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
    // Many clients (and reverse proxies) buffer until SOMETHING flushes.
    // Emit a single ":ping" comment immediately so the connection
    // graduates to "streaming" on the client side without waiting for
    // the first poll's 500ms.
    reply.raw.write(': stream-open\n\n');

    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());

    try {
      await this.imports.streamProgress({
        user,
        id,
        write: (ev) => reply.raw.write(encodeSseFrame(ev)),
        signal: abort.signal,
      });
    } finally {
      // Close the underlying socket. The frame writes above are best-
      // effort; if reply.raw is already closed (client disconnected),
      // end() is a no-op.
      reply.raw.end();
    }
  }
}
