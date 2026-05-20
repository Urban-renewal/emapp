import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

/**
 * ThrottlerGuard with a PROD-SAFE, env-gated per-request bypass.
 *
 * The capability is OFF unless `THROTTLE_TEST_BYPASS` is set AND
 * NODE_ENV !== 'production' (audit-pass III F1 — the doc said "never in
 * production" but the code did not enforce it. An ops typo putting the
 * env var in prod would have silently defeated every rate limit for
 * anyone who knew the value. Now blocked structurally even if the env
 * is set.). Bypass also requires `x-throttle-bypass: <that exact value>`
 * header. This lets the black-box conformance suite exercise functional
 * flows without its own burst tripping the limiter, while requests
 * WITHOUT the header (e.g. the brute-force clause) are still throttled
 * normally — and prod is always throttled regardless of any header.
 */
@Injectable()
export class ConfigurableThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    // Hard refuse in production — fail-closed even on env misconfig.
    if (process.env['NODE_ENV'] === 'production') return super.shouldSkip(context);
    const secret = process.env['THROTTLE_TEST_BYPASS'];
    if (secret) {
      const req = context.switchToHttp().getRequest<FastifyRequest>();
      const hdr = req.headers['x-throttle-bypass'];
      if (typeof hdr === 'string' && hdr === secret) return true;
    }
    return super.shouldSkip(context);
  }
}
