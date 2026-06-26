/**
 * Fail-closed wrappers around the pure dev-auth-bypass gate.
 *
 * The pure gate (dev-auth-bypass.spec.ts) already proves `undefined` NODE_ENV →
 * disabled. THIS spec proves the env-reading wrappers actually FEED it the raw,
 * UNDEFAULTED NODE_ENV — i.e. an UNSET NODE_ENV does NOT enable the bypass and
 * makes the boot guard refuse to start. (Regression for the G-RT finding: an
 * earlier version read `serverEnv.NODE_ENV`, which `.default('development')`, so
 * an unset NODE_ENV + DEV_AUTH_BYPASS=1 silently armed the bypass.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted so the mutable env object exists BEFORE the hoisted vi.mock factory.
const { mockServerEnv } = vi.hoisted(() => ({
  mockServerEnv: { NODE_ENV: 'test', DEV_AUTH_BYPASS: undefined as string | undefined },
}));
vi.mock('@emapp/config', () => ({ serverEnv: mockServerEnv }));

import { assertDevBypassNotInProduction, isDevAuthBypass } from './dev-auth-bypass';

describe('isDevAuthBypass / assertDevBypassNotInProduction — fail-closed on UNSET NODE_ENV', () => {
  const orig = process.env['NODE_ENV'];
  beforeEach(() => {
    mockServerEnv.DEV_AUTH_BYPASS = undefined;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = orig;
  });

  function setEnv(nodeEnv: string | undefined, flag: string | undefined): void {
    if (nodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = nodeEnv;
    mockServerEnv.DEV_AUTH_BYPASS = flag;
  }

  it('isDevAuthBypass: true ONLY for explicit NODE_ENV=development + flag=1', () => {
    setEnv('development', '1');
    expect(isDevAuthBypass()).toBe(true);
  });

  it('isDevAuthBypass: FALSE when NODE_ENV is UNSET even with flag=1 (the fix — no serverEnv default)', () => {
    setEnv(undefined, '1');
    expect(isDevAuthBypass()).toBe(false);
  });

  it('isDevAuthBypass: FALSE in production, and when the flag is absent', () => {
    setEnv('production', '1');
    expect(isDevAuthBypass()).toBe(false);
    setEnv('development', undefined);
    expect(isDevAuthBypass()).toBe(false);
  });

  it('boot guard THROWS when flag=1 and NODE_ENV is UNSET (leaked into a deploy)', () => {
    setEnv(undefined, '1');
    expect(() => assertDevBypassNotInProduction()).toThrow(/<unset>/);
  });

  it('boot guard THROWS when flag=1 and NODE_ENV=production', () => {
    setEnv('production', '1');
    expect(() => assertDevBypassNotInProduction()).toThrow(/refusing to start/);
  });

  it('boot guard does NOT throw for explicit development / test (legit dev + CI)', () => {
    setEnv('development', '1');
    expect(() => assertDevBypassNotInProduction()).not.toThrow();
    setEnv('test', '1');
    expect(() => assertDevBypassNotInProduction()).not.toThrow();
  });

  it('boot guard does NOT throw when the flag is absent, for any NODE_ENV', () => {
    setEnv(undefined, undefined);
    expect(() => assertDevBypassNotInProduction()).not.toThrow();
    setEnv('production', undefined);
    expect(() => assertDevBypassNotInProduction()).not.toThrow();
  });
});
