/**
 * D.37 / Phase 6.5 closeout (gap #3) — runtime enforcement of
 * `PROVIDER_POLICY` (apps/api/src/common/authz/policy.ts).
 *
 * Pre-closeout the matrix existed as a documented + compile-time-pinned
 * invariant (the `@ts-expect-error` tests in policy.spec.ts catch
 * structural tier mix-ups), but no controller actually called
 * `canProvider()`. Practical role gating relied on `ProviderAuthGuard`'s
 * hard-coded `payload.role !== 'provider_admin'` check at line 37 — fine
 * today (one role per audience), but if a future scope decision adds
 * `provider_viewer` (read-only) or `provider_billing_admin` (subset
 * surface), the matrix would silently fail to enforce until someone
 * remembered to add a fresh if-statement to the guard.
 *
 * This guard makes the matrix load-bearing. It runs AFTER
 * `ProviderAuthGuard` (so `req.providerUser` is populated) and consults
 * `canProvider(role, 'provider', 'read')`. Today that returns true iff
 * role==='provider_admin', so behaviour is unchanged. Tomorrow, when a
 * new provider role lands, ONLY editing `PROVIDER_POLICY` (with a D.NN
 * widening entry per the comment in policy.ts) changes runtime
 * enforcement — no second source of truth.
 *
 * Symmetric with the org-tier `AuthorizationGuard`. We deliberately do
 * NOT verb→action map here because every Provider endpoint is GET-only
 * (D.37 Gate-6 invariant) and the action literal is hard-coded to
 * `'read'`. If a future write ever lands, the controller must use a
 * different decorator pattern and `ProviderAction` must widen first —
 * the type system will block this guard from accepting a non-'read'
 * action automatically.
 *
 * Fail-closed: missing or invalid principal → 403 forbidden (D.16).
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { canProvider, type ProviderRole } from '../../common/authz/policy';

import type { ProviderPrincipal } from './current-provider.decorator';

@Injectable()
export class ProviderAuthorizationGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { providerUser?: ProviderPrincipal }>();
    const role = req.providerUser?.role as ProviderRole | undefined;
    // Fail-CLOSED: no principal (would only happen if a future refactor
    // wires this guard without ProviderAuthGuard upstream — defense-in-
    // depth, not a path that should ever fire in production).
    if (!role) {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }
    // Phase 6.5 surface is read-only. Action literal is structurally
    // 'read' — the ProviderAction type is exactly that single literal.
    if (!canProvider(role, 'provider', 'read')) {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }
    return true;
  }
}
