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

import type { ProviderAction } from '../../common/authz/policy';

import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { PROVIDER_AUTHZ_ACTION } from './provider-authz.decorators';

interface FakeCtxOpts {
  providerUser?: { role?: string };
  /** When set, a handler carrying @RequireProviderAction(action) metadata
   *  is supplied via getHandler() (the D.49 write path). When omitted,
   *  getHandler is ABSENT entirely — proving the guard resolves the safe
   *  'read' default for the pre-D.49 pure-unit context shape. */
  action?: ProviderAction;
}

function fakeCtx(opts: FakeCtxOpts): ExecutionContext {
  const base: Record<string, unknown> = {
    switchToHttp: () => ({
      getRequest: () => ({ providerUser: opts.providerUser }),
    }),
  };
  if (opts.action !== undefined) {
    const handler = (): void => undefined;
    Reflect.defineMetadata(PROVIDER_AUTHZ_ACTION, opts.action, handler);
    base['getHandler'] = () => handler;
  }
  return base as unknown as ExecutionContext;
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

  // ── D.49 write-action enforcement ────────────────────────────────────
  // Evidence (c): the guard gates a WRITE handler against the matrix's
  // `write` action, not a hard-coded 'read'.

  it('D49-AUTHZ-1) write handler + provider_admin → ALLOW (canProvider write granted)', () => {
    expect(
      g.canActivate(fakeCtx({ providerUser: { role: 'provider_admin' }, action: 'write' })),
    ).toBe(true);
  });

  it('D49-AUTHZ-2) write handler + unknown role → 403 (write is still role-gated)', () => {
    expect(() =>
      g.canActivate(fakeCtx({ providerUser: { role: 'manager' }, action: 'write' })),
    ).toThrow(/Forbidden|forbidden/);
    expect(() =>
      g.canActivate(fakeCtx({ providerUser: { role: 'provideradmin' }, action: 'write' })),
    ).toThrow(/Forbidden|forbidden/);
  });

  it('D49-AUTHZ-3) explicit read handler + provider_admin → ALLOW (read path still works)', () => {
    expect(
      g.canActivate(fakeCtx({ providerUser: { role: 'provider_admin' }, action: 'read' })),
    ).toBe(true);
  });
});
