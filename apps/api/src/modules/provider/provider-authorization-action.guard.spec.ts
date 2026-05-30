/**
 * D.49 — ProviderAuthorizationGuard ACTION-RESOLUTION mechanism proof.
 *
 * This is the anti-plaster pin (D.51): it proves the guard passes the
 * action declared by `@RequireProviderAction(...)` (default `'read'`)
 * THROUGH to `canProvider`. A plaster that hard-coded
 * `canProvider(role, 'provider', 'read')` — silently ungating writes —
 * would FAIL `D49-RESOLVE-1` because the captured action would be 'read'
 * for a write handler.
 *
 * We mock the policy module so we observe the exact (role, resource,
 * action) tuple the guard requests, independent of what the real matrix
 * grants. (Kept in its own file: the vi.mock is module-hoisted, so the
 * real-behaviour guard spec stays unmocked.)
 */
import { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { PROVIDER_AUTHZ_ACTION } from './provider-authz.decorators';

const canProviderSpy = vi.fn((..._args: unknown[]): boolean => true);
vi.mock('../../common/authz/policy', () => ({
  canProvider: (...args: unknown[]) => canProviderSpy(...args),
}));

// Import AFTER vi.mock so the guard binds to the mocked canProvider.
const { ProviderAuthorizationGuard } = await import('./provider-authorization.guard');

function ctx(role: string, action?: 'read' | 'write'): ExecutionContext {
  const base: Record<string, unknown> = {
    switchToHttp: () => ({ getRequest: () => ({ providerUser: { role } }) }),
  };
  if (action !== undefined) {
    const handler = (): void => undefined;
    Reflect.defineMetadata(PROVIDER_AUTHZ_ACTION, action, handler);
    base['getHandler'] = () => handler;
  }
  return base as unknown as ExecutionContext;
}

describe('D.49 ProviderAuthorizationGuard — action resolution mechanism', () => {
  const g = new ProviderAuthorizationGuard();
  beforeEach(() => canProviderSpy.mockClear());

  it('D49-RESOLVE-1) a @RequireProviderAction("write") handler → canProvider called with action "write"', () => {
    g.canActivate(ctx('provider_admin', 'write'));
    expect(canProviderSpy).toHaveBeenCalledTimes(1);
    expect(canProviderSpy).toHaveBeenCalledWith('provider_admin', 'provider', 'write');
  });

  it('D49-RESOLVE-2) no action metadata → canProvider called with the safe default "read"', () => {
    g.canActivate(ctx('provider_admin'));
    expect(canProviderSpy).toHaveBeenCalledWith('provider_admin', 'provider', 'read');
  });

  it('D49-RESOLVE-3) an explicit read handler → canProvider called with "read"', () => {
    g.canActivate(ctx('provider_admin', 'read'));
    expect(canProviderSpy).toHaveBeenCalledWith('provider_admin', 'provider', 'read');
  });
});
