/**
 * D.37 / Phase 6.5 — `@CurrentProvider()` param decorator.
 *
 * Mirrors `@CurrentUser()` for the Provider tier (D.29 tier isolation).
 * ProviderAuthGuard puts the verified `ProviderTokenPayload` on
 * `req.providerUser`; this decorator extracts it + enriches with IP /
 * User-Agent for the audit trail (ISO 27001 A.12.4).
 *
 * **Audit v1.1 CC-4 (ISP) closure.** Pre-closure the decorator returned
 * `ProviderPrincipal extends ProviderTokenPayload` — services received
 * the full JWT payload (`role`, `sid`, `type`) when they only used
 * `sub`, `ip`, `userAgent`. The wider type forced services to depend
 * on the JWT schema; tests needed to construct full payloads just to
 * call a service method. Switching to a narrow `ProviderActor` removes
 * the dependency, and a future change to the JWT payload no longer
 * ripples into the 4 services.
 *
 * Defence-in-depth (CC-4 spec note): the decorator now also asserts
 * `req.providerUser` is populated. If a future refactor places this
 * decorator on a route without `ProviderAuthGuard` upstream, the
 * decorator throws rather than producing a half-formed actor object
 * — which `ProviderAuthorizationGuard` would later reject with 403,
 * but at the cost of an unaudited 401-class failure that the
 * decorator surfaces sooner.
 */
import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { ProviderTokenPayload } from '../auth/provider/provider-auth.service';

/**
 * Narrow actor surface exposed to services + `withProvider`.
 * Services only consume `sub` (the `providerUserId` argument) plus
 * the audit-row enrichment fields. Anything else (role, sid, type)
 * stays in the controller / guard layer where it belongs.
 */
export interface ProviderActor {
  /** providerUserId — UUID, becomes the `provider_user_id` audit column. */
  sub: string;
  /** Trusted source IP (Audit v1.1 CC-1 — trustProxy:1 means single-hop). */
  ip?: string;
  /** Truncated to 512 chars to bound audit-row growth. */
  userAgent?: string;
}

/**
 * Back-compat alias. The 4 service classes previously imported
 * `ProviderPrincipal` from this file; keeping the name as an alias
 * avoids touching all consumers in this PR. Future PRs can rename
 * call sites at leisure; the structural ISP win (narrow shape) is
 * already in place because the alias resolves to the narrow type.
 */
export type ProviderPrincipal = ProviderActor;

export const CurrentProvider = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ProviderActor => {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { providerUser?: ProviderTokenPayload }>();
    // CC-4 defence-in-depth: fail loud if upstream auth never ran.
    // ProviderAuthorizationGuard would also reject, but a missing
    // principal here means the request shape is structurally wrong.
    const payload = req.providerUser;
    if (!payload || typeof payload.sub !== 'string') {
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    const ua = req.headers['user-agent'];
    return {
      sub: payload.sub,
      ip: req.ip,
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : undefined,
    };
  },
);
