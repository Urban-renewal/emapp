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

  /**
   * Per-USER tracking when authenticated; per-IP fallback for anonymous
   * (login / signup / OTP — pre-auth). docs/02 §8.2 T08 prescribes per-user
   * limits; the default `ThrottlerGuard.getTracker(req)` returns `req.ip`,
   * which means N users behind one NAT share a single bucket. Overriding
   * with `req.user?.sub` (the JWT subject set by AuthGuard) fixes that
   * without sacrificing the IP brake for unauthenticated flows.
   *
   * Edge case — invalid token: AuthGuard throws BEFORE reaching the
   * domain handler, so `req.user` is unset on those paths → IP fallback
   * (no user-bucket pollution from forged tokens).
   */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = (req as { user?: { sub?: unknown } }).user;
    if (user && typeof user.sub === 'string' && user.sub.length > 0) {
      return `u:${user.sub}`;
    }
    // Tenant-tier routes (TenantAuthGuard) attach `req.tenant`, not `req.user`.
    // Key per-OWNER so an SMS-sending tenant write (portal resend) is throttled
    // by the authenticated owner, not just per-IP (a stolen-token holder could
    // otherwise rotate egress IPs to exceed the per-owner cap). sec-review MED.
    const tenant = (req as { tenant?: { sub?: unknown } }).tenant;
    if (tenant && typeof tenant.sub === 'string' && tenant.sub.length > 0) {
      return `t:${tenant.sub}`;
    }
    const ip = (req as { ip?: unknown }).ip;
    return typeof ip === 'string' && ip.length > 0 ? `ip:${ip}` : 'anon';
  }
}
