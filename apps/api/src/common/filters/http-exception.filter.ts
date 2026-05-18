import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
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
      const msg = exception instanceof Error ? exception.message : '';
      const code = /invalid json/i.test(msg) ? 'invalid_json' : 'bad_request';
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
      let cause: unknown = (exception as { cause?: unknown })?.cause;
      let depth = 0;
      while (cause && depth < 5) {
        const pg = cause as { message?: string; code?: string; detail?: string; hint?: string };
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
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body) {
        reply.status(status).send(body);
        return;
      }
    }

    // The pg-cause chain can echo column values / schema internals. It is
    // EXPOSED ONLY when AUTH_DEBUG_ERRORS is explicitly set (opt-in, never
    // by default) — gating on "not production" would leak it on staging too.
    // The full chain is always available in server logs (logger.error above).
    const debugOptIn = process.env['AUTH_DEBUG_ERRORS'] === '1';
    reply.status(status).send({
      error: {
        code: String(status),
        message: 'Internal server error',
        ...(debugOptIn && debugChain.length > 0 ? { debug: debugChain } : {}),
      },
    });
  }
}
