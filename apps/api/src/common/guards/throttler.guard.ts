import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

/**
 * ThrottlerGuard with a PROD-SAFE, env-gated per-request bypass.
 *
 * The capability is OFF unless `THROTTLE_TEST_BYPASS` is set in the
 * environment (never in production — same posture as AUTH_DEBUG_ERRORS).
 * Even when enabled, an individual request is only exempted if it carries
 * `x-throttle-bypass: <that exact value>`. This lets the black-box
 * conformance suite exercise functional flows without its own burst
 * tripping the limiter, while requests WITHOUT the header (e.g. the
 * brute-force clause) are still throttled normally.
 */
@Injectable()
export class ConfigurableThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const secret = process.env['THROTTLE_TEST_BYPASS'];
    if (secret) {
      const req = context.switchToHttp().getRequest<FastifyRequest>();
      const hdr = req.headers['x-throttle-bypass'];
      if (typeof hdr === 'string' && hdr === secret) return true;
    }
    return super.shouldSkip(context);
  }
}
