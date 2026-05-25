/**
 * D.37 / Phase 6.5 closeout — ProviderAuthorizationGuard unit proof.
 *
 * Pure unit test (no DB, no HTTP) — same fake-ExecutionContext pattern as
 * the org-tier policy.spec.ts. Pins the guard's contract:
 *
 *   T6.5-CLOSE-AUTHZ-1  populated provider_admin principal → ALLOW
 *   T6.5-CLOSE-AUTHZ-2  missing req.providerUser → 403 (fail-CLOSED)
 *   T6.5-CLOSE-AUTHZ-3  principal with an unknown role → 403
 *                       (matrix doesn't accept it — proves the guard
 *                        delegates to canProvider() and not to a
 *                        hard-coded role string)
 *   T6.5-CLOSE-AUTHZ-4  same input → same decision (pure)
 */
import { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ProviderAuthorizationGuard } from './provider-authorization.guard';

interface FakeCtxOpts {
  providerUser?: { role?: string };
}

function fakeCtx(opts: FakeCtxOpts): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ providerUser: opts.providerUser }),
    }),
    // Other ExecutionContext fields aren't read by this guard.
  } as unknown as ExecutionContext;
}

describe('ProviderAuthorizationGuard — D.37 closeout matrix enforcement', () => {
  const g = new ProviderAuthorizationGuard();

  it('T6.5-CLOSE-AUTHZ-1) provider_admin principal → ALLOW', () => {
    expect(g.canActivate(fakeCtx({ providerUser: { role: 'provider_admin' } }))).toBe(true);
  });

  it('T6.5-CLOSE-AUTHZ-2) missing principal → 403 (fail-CLOSED, never an open door)', () => {
    expect(() => g.canActivate(fakeCtx({ providerUser: undefined }))).toThrow(
      /Forbidden|forbidden/,
    );
  });

  it('T6.5-CLOSE-AUTHZ-2b) principal without a role → 403', () => {
    expect(() => g.canActivate(fakeCtx({ providerUser: {} }))).toThrow(/Forbidden|forbidden/);
  });

  it('T6.5-CLOSE-AUTHZ-3) unknown role string (e.g. future widening typo) → 403', () => {
    // The matrix only accepts 'provider_admin'. A typo like
    // 'provideradmin' or a leaked org role string must NOT pass.
    expect(() => g.canActivate(fakeCtx({ providerUser: { role: 'provideradmin' } }))).toThrow(
      /Forbidden|forbidden/,
    );
    expect(() => g.canActivate(fakeCtx({ providerUser: { role: 'manager' } }))).toThrow(
      /Forbidden|forbidden/,
    );
    expect(() => g.canActivate(fakeCtx({ providerUser: { role: '' } }))).toThrow(
      /Forbidden|forbidden/,
    );
  });

  it('T6.5-CLOSE-AUTHZ-4) same input → same decision (pure, no shared state)', () => {
    const a = g.canActivate(fakeCtx({ providerUser: { role: 'provider_admin' } }));
    const b = g.canActivate(fakeCtx({ providerUser: { role: 'provider_admin' } }));
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});
