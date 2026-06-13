import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { FastifyReply } from 'fastify';

// D.16: error envelope { error: { code, message, details? } }
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    // A non-HttpException that carries a numeric status (Fastify/parser
    // convention — e.g. the JSON content-type parser sets statusCode=400)
    // is a CLIENT error, not a 500. Honour it so malformed input returns a
    // clean D.16 4xx instead of leaking as "Internal server error".
    const carriedStatus = ((): number | undefined => {
      const s =
        (exception as { statusCode?: unknown; status?: unknown })?.statusCode ??
        (exception as { status?: unknown })?.status;
      return typeof s === 'number' && s >= 400 && s < 500 ? s : undefined;
    })();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : (carriedStatus ?? HttpStatus.INTERNAL_SERVER_ERROR);

    if (!(exception instanceof HttpException) && carriedStatus) {
      // Use the STABLE discriminator the thrower attached (e.g. the JSON
      // parser sets code:'invalid_json'). No message string-matching:
      // only our own allow-listed lowercase codes are echoed; anything
      // else (incl. Fastify's FST_ERR_* codes) → generic 'bad_request'.
      const ec = (exception as { code?: unknown }).code;
      const code = ec === 'invalid_json' ? 'invalid_json' : 'bad_request';
      reply.status(carriedStatus).send({ error: { code } });
      return;
    }

    const debugChain: Array<Record<string, unknown>> = [];

    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
      if (exception instanceof Error) {
        debugChain.push({ message: exception.message });
      }
      const pgCodes: string[] = [];
      let cause: unknown = (exception as { cause?: unknown })?.cause;
      let depth = 0;
      while (cause && depth < 5) {
        const pg = cause as { message?: string; code?: string; detail?: string; hint?: string };
        if (pg.code) pgCodes.push(pg.code);
        this.logger.error(
          `  ↳ cause[${depth}] pgcode=${pg.code ?? '?'} ${pg.message ?? String(cause)}${pg.detail ? ` | detail=${pg.detail}` : ''}${pg.hint ? ` | hint=${pg.hint}` : ''}`,
        );
        debugChain.push({
          pgcode: pg.code,
          message: pg.message ?? String(cause),
          detail: pg.detail,
          hint: pg.hint,
        });
        cause = (cause as { cause?: unknown })?.cause;
        depth += 1;
      }

      // S1 (audit Theme A — observability) — report the 5xx to Sentry so an
      // in-request fault is not invisible to the alerting tool. The full cause
      // (incl. pg detail/hint) is ALREADY in the server logs above for forensics;
      // before handing the error to Sentry — an EXTERNAL service — scrub the pg
      // `cause.detail`/`hint` IN PLACE, because those carry column VALUES (e.g.
      // `Key (national_id)=(…)`), i.e. PII that must never leave the boundary
      // (root CLAUDE.md). The pgcode + top message + stack are PII-safe and stay,
      // so Sentry keeps real grouping/stack. The exception is terminal here
      // (response about to be sent), so mutating it has no downstream reader.
      let scrub: unknown = (exception as { cause?: unknown })?.cause;
      let sdepth = 0;
      while (scrub && sdepth < 5) {
        const c = scrub as { detail?: unknown; hint?: unknown; cause?: unknown };
        delete c.detail;
        delete c.hint;
        scrub = c.cause;
        sdepth += 1;
      }
      Sentry.captureException(exception, {
        level: 'error',
        tags: { httpStatus: status },
        ...(pgCodes.length > 0 ? { contexts: { pg: { codes: pgCodes } } } : {}),
      });
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        // Some bodies already have the D.16 envelope shape — pass through.
        // (NestJS's default NotFoundException body has `error: 'Not Found'`
        // as a STRING — not the D.16 `error: {code,message}` OBJECT — so
        // fall through to the per-status normalization below.)
        const errVal = (body as { error: unknown }).error;
        if (typeof errVal === 'object' && errVal !== null) {
          reply.status(status).send(body);
          return;
        }
      }
      // §M-1 — 404 NotFoundException (unmatched route) → D.16 envelope.
      // NestJS's default body for NotFoundException is
      //   { statusCode: 404, message: 'Cannot GET /api/v1/foo', error: 'Not Found' }
      // which leaks the Fastify "Not Found" string AND the requested path.
      // Rewrite to the D.16 shape with a generic code.
      if (status === HttpStatus.NOT_FOUND) {
        reply.status(404).send({ error: { code: 'not_found' } });
        return;
      }
      // Other HttpException shapes (e.g. NestJS's default 400 body) — pass
      // the status through but normalize the body to D.16. Use the lowercase
      // discriminator from the exception (most internal throws set it).
      const codeFromExc = (exception as { code?: unknown }).code;
      const code = typeof codeFromExc === 'string' ? codeFromExc : `http_${status}`;
      reply.status(status).send({ error: { code } });
      return;
    }

    // The pg-cause chain can echo column values / schema internals. It is
    // EXPOSED ONLY when AUTH_DEBUG_ERRORS=1 AND we are NOT in production
    // (audit-pass V #3 — hardened 2026-05-20: previously env-only, an ops
    // typo putting the env var in prod Infisical would have leaked schema
    // details. Same fail-closed posture as F1 in the throttler. Staging
    // and dev still get the debug body when the flag is on; prod refuses
    // structurally even if the flag is somehow set). The full chain is
    // always available in server logs (logger.error above) for forensics.
    const debugOptIn =
      process.env['AUTH_DEBUG_ERRORS'] === '1' && process.env['NODE_ENV'] !== 'production';
    reply.status(status).send({
      error: {
        code: String(status),
        message: 'Internal server error',
        ...(debugOptIn && debugChain.length > 0 ? { debug: debugChain } : {}),
      },
    });
  }
}
