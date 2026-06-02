import { describe, expect, it } from 'vitest';

import { computeDevAuthBypass, DEV_FIXED_AUTH_CODE } from './dev-auth-bypass.gate';

/**
 * SECURITY GUARD — the dev auth bypass must be provably impossible outside a
 * deliberately-flagged development environment. If any of these fail, the
 * fixed dev code could be accepted in production. This spec is the gate.
 */
describe('dev-auth-bypass gate (security guard)', () => {
  it('ENABLED only when NODE_ENV=development AND DEV_AUTH_BYPASS=1', () => {
    expect(computeDevAuthBypass('development', '1')).toBe(true);
  });

  it('DISABLED in production even if the flag is somehow set', () => {
    expect(computeDevAuthBypass('production', '1')).toBe(false);
  });

  it('DISABLED when NODE_ENV is unset/undefined (misconfigured prod) even with flag=1', () => {
    expect(computeDevAuthBypass(undefined, '1')).toBe(false);
  });

  it('DISABLED in development when the explicit flag is absent (the real guard)', () => {
    expect(computeDevAuthBypass('development', undefined)).toBe(false);
    expect(computeDevAuthBypass('development', '')).toBe(false);
    expect(computeDevAuthBypass('development', '0')).toBe(false);
    expect(computeDevAuthBypass('development', 'true')).toBe(false);
  });

  it('DISABLED for test/staging-like NODE_ENV values', () => {
    for (const env of ['test', 'staging', 'prod', 'Production', 'DEVELOPMENT']) {
      expect(computeDevAuthBypass(env, '1')).toBe(false);
    }
  });

  it('the fixed dev code is exactly 6 zeros (no accidental real-credential shape)', () => {
    expect(DEV_FIXED_AUTH_CODE).toBe('000000');
  });
});
