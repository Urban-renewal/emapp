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

    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
      let cause: unknown = (exception as { cause?: unknown })?.cause;
      let depth = 0;
      while (cause && depth < 5) {
        const pg = cause as { message?: string; code?: string; detail?: string; hint?: string };
        this.logger.error(
          `  ↳ cause[${depth}] pgcode=${pg.code ?? '?'} ${pg.message ?? String(cause)}${pg.detail ? ` | detail=${pg.detail}` : ''}${pg.hint ? ` | hint=${pg.hint}` : ''}`,
        );
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

    reply.status(status).send({
      error: {
        code: String(status),
        message: 'Internal server error',
      },
    });
  }
}
