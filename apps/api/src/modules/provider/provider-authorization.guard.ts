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
 * Symmetric with the org-tier `AuthorizationGuard`. D.49 opened Provider
 * WRITE actions, so the guard now resolves the required `ProviderAction`
 * from `@RequireProviderAction(...)` metadata on the handler, DEFAULTING
 * to `'read'` when absent (every GET endpoint stays correctly gated with
 * no annotation). It then consults `canProvider(role, 'provider', action)`
 * — a write route the matrix does not grant fails closed.
 *
 * Fail-closed: missing or invalid principal → 403 forbidden (D.16).
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { canProvider, type ProviderAction, type ProviderRole } from '../../common/authz/policy';
import type { ProviderTokenPayload } from '../auth/provider/provider-auth.service';

import { PROVIDER_AUTHZ_ACTION } from './provider-authz.decorators';

@Injectable()
export class ProviderAuthorizationGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    // The authorization guard reads the FULL JWT payload (role lives
    // there, not on the narrowed ProviderActor that the decorator
    // produces for services — Audit v1.1 CC-4).
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { providerUser?: ProviderTokenPayload }>();
    const role = req.providerUser?.role as ProviderRole | undefined;
    // Fail-CLOSED: no principal (would only happen if a future refactor
    // wires this guard without ProviderAuthGuard upstream — defense-in-
    // depth, not a path that should ever fire in production).
    if (!role) {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }
    // D.49 — resolve the required action from handler metadata, default
    // 'read'. `getHandler` is guarded so the pure-unit fake-context tests
    // (which only stub switchToHttp) still resolve the safe default.
    const handler =
      typeof ctx.getHandler === 'function' ? (ctx.getHandler() as object | undefined) : undefined;
    const action: ProviderAction =
      (handler && (Reflect.getMetadata(PROVIDER_AUTHZ_ACTION, handler) as ProviderAction)) ??
      'read';
    if (!canProvider(role, 'provider', action)) {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }
    return true;
  }
}
