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
 *   `imports` = manager+agent, D.46) → withTenant (RLS FORCE org-isolation)
 *   → service: assertProjectVisible + requireAgentCapability('run_imports')
 *   (manager no-op) → business-rule guards (creator-only + state-machine).
 */
import {
  CreateImportInput,
  ListImportErrorsQuery,
  ListImportsQuery,
  StartImportInput,
  SubmitMappingInput,
  type CreateImport,
  type ListImportErrorsQueryDto,
  type ListImportsQueryDto,
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
import { RequirePermission } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { encodeSseFrame, ImportsService } from './imports.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());

@Controller('imports')
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
  @RequirePermission('imports.run')
  async create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(CreateImportInput)) body: CreateImport,
  ) {
    return { data: await this.imports.create(user, body) };
  }

  // GET /imports — §P0-2 closure (post-S11 manual smoke catch).
  // Read = ALL per D.17 (Manager + Viewer see org-wide; Agent
  // restricted to imports whose projectId is in their assignments).
  // Returns { data, page } directly — the D.16 list envelope shape.
  @Get()
  @RequirePermission('imports.read')
  async list(
    @CurrentUser() user: AccessTokenPayload,
    @Query(new ZodValidationPipe(ListImportsQuery)) query: ListImportsQueryDto,
  ) {
    return this.imports.list(user, query);
  }

  @Get(':id')
  @RequirePermission('imports.read')
  async get(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.imports.get(user, id) };
  }

  // POST /imports/:id/start — enqueue the worker job. Same throttle
  // class as create (cheap on the API but kicks off heavy worker
  // work; a runaway client could DoS the worker pool).
  // v5 audit fix (HIGH security): POST default-maps to `create` in
  // the AuthorizationGuard's verb→action table, but /start mutates
  // an EXISTING row — semantically `update`. Annotating explicitly
  // so a future policy change that differentiates create vs update
  // doesn't silently misroute.
  @Post(':id/start')
  @RequirePermission('imports.map')
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
  @RequirePermission('imports.cancel')
  async cancel(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    await this.imports.cancel(user, id);
  }

  @Get(':id/errors')
  @RequirePermission('imports.read')
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
  // v5 audit fix (HIGH security): POST default-maps to `create`; the
  // wizard mutates an existing row → `update`. See start() above.
  @Post(':id/mapping')
  @RequirePermission('imports.map')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  async submitMapping(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Body(new ZodValidationPipe(SubmitMappingInput)) body: SubmitMapping,
  ) {
    return { data: await this.imports.submitMapping(user, id, body) };
  }

  /** POST /imports/:id/confirm — 0048 preview→confirm. Commit a preview-paused
   *  import (status='awaiting_confirm'): re-queues a full real run that
   *  persists. Creator-only (in the service). `imports.map` coarse gate (same
   *  as mapping — it mutates an existing row's lifecycle, not a fresh create). */
  @Post(':id/confirm')
  @RequirePermission('imports.map')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  async confirm(@CurrentUser() user: AccessTokenPayload, @Param('id', UuidParam) id: string) {
    return { data: await this.imports.confirm(user, id) };
  }

  /** SSE progress stream. See file header for full explanation.
   *
   *  v8-S2 (security/perf P0): @Throttle bounds NEW stream opens per
   *  Manager so a malicious script can't fan out N EventSources to
   *  saturate the pg pool (every active stream polls every 500ms).
   *  5 opens / 60s is generous for legit UIs (one open per import
   *  detail view) while bounding the per-IP DoS surface to a
   *  predictable ceiling. The per-process MAX_ACTIVE_STREAMS cap
   *  (below) is the second line of defense: even if many distinct
   *  IPs each fire 5 opens, this Fastify worker refuses past N
   *  concurrent active streams with a 503 (back-pressure rather
   *  than degradation).
   *
   *  Note: the @Throttle key is route+IP; behind a trustproxy the
   *  real client IP is used. For browser tabs that legitimately want
   *  more than 5 imports open at once, the FE should reuse one
   *  EventSource per import (the polling state shares cleanly). */
  @Get(':id/stream')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('imports.read')
  async stream(
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) id: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Per-process max-concurrent-streams cap. Reject EARLY (before
    // writing the 200 / SSE headers) so the FE sees a real 503 it
    // can handle, not a half-open SSE stream. We MUST decrement on
    // every exit path — try/finally below.
    if (ImportsController.activeStreams >= ImportsController.MAX_ACTIVE_STREAMS) {
      reply.raw.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      reply.raw.end(
        JSON.stringify({
          error: { code: 'too_many_concurrent_streams', message: 'try again in a moment' },
        }),
      );
      return;
    }

    // v8.5 P0 FIX (Audit SOLID #3 + Sec HIGH-6 — cross-confirmed):
    //   Pre-v8.5 the `activeStreams += 1` lived OUTSIDE the try/finally.
    //   Any synchronous throw between the increment and try-entry (e.g.
    //   `writeHead` failing because the socket was already closed by
    //   the client during the cap-check window) would leak the counter
    //   forever — finally never runs because we never entered try.
    //   Repeated under load, a single pod's counter monotonically
    //   climbs to MAX_ACTIVE_STREAMS and ALL subsequent SSE requests
    //   get a permanent 503 until the pod is restarted (per-pod DoS).
    //
    //   v8.5 fix: increment FIRST (so the cap is honored — TOCTOU-safe
    //   with the check immediately above), then wrap EVERY subsequent
    //   side-effect (writeHead, write, streamProgress) in the single
    //   try/finally. The finally is now the only path that touches
    //   the counter, so a leak is structurally impossible.
    ImportsController.activeStreams += 1;
    try {
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
        try {
          reply.raw.end();
        } catch {
          /* socket already dead */
        }
      }
    } finally {
      ImportsController.activeStreams -= 1;
    }
  }

  /** v8-S2: per-process bound on active SSE streams.
   *
   *  Math: each active stream calls `this.get()` every 500ms via
   *  withTenant, which acquires a pg client for ~4 round-trips.
   *  With DB_POOL_MAX=20 (apps/api default), 5 active streams hold
   *  ~4 round-trips/500ms × 5 = 40 RT/s but at most 5 in-flight pool
   *  clients at any instant (the cycle is fast). 50 active streams
   *  saturates the pool; 100 will queue beyond pool's
   *  connectionTimeoutMillis and 503 new requests on OTHER endpoints.
   *  Cap at 30 active streams per process — leaves plenty of room
   *  for non-SSE traffic and is well above any realistic FE need
   *  (one Manager open on multiple tabs = ~5; an org with several
   *  active import wizards = ~10).
   *
   *  Across-process cap (multi-pod) is naturally bounded by
   *  `pods × MAX_ACTIVE_STREAMS`. Document in OPEN-ITEMS-v8 §v8-S2
   *  Phase 2 (LISTEN/NOTIFY) for the real fix that eliminates the
   *  per-stream pg client churn entirely. */
  private static readonly MAX_ACTIVE_STREAMS = 30;
  /** Mutable per-process counter. Static so it's shared across
   *  controller instances (Nest creates one per request scope by
   *  default — even though this controller is request-scoped, the
   *  static field is module-scoped). */
  private static activeStreams = 0;

  /** Test-only seam — reset the counter between specs so cross-spec
   *  state doesn't leak. Intentionally NOT prefixed `_test` so any
   *  production code that wants to reset (e.g. for health-check
   *  recovery) can call it; the cost is one assignment. */
  static resetActiveStreamsForTests(): void {
    ImportsController.activeStreams = 0;
  }
}
