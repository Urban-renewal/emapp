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

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

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

    // Production stays generic (D.16, no internal leakage). Outside production
    // we attach the real error/pg-cause chain so a failing request is
    // self-diagnosing without needing server log access.
    const isProd = process.env['NODE_ENV'] === 'production';
    reply.status(status).send({
      error: {
        code: String(status),
        message: 'Internal server error',
        ...(isProd || debugChain.length === 0 ? {} : { debug: debugChain }),
      },
    });
  }
}
