import { serverEnv } from '@emapp/config';
import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { SignupDto } from './dto/signup.dto';

/**
 * LOAD-BEARING GUARD SPEC — public self-service signup is INACTIVE by default
 * (PUBLIC_SIGNUP_ENABLED unset/'0', owner-approved, refines D.21). When off,
 * `POST /auth/signup` must behave as if the route does not exist: a 404
 * (NotFoundException) thrown BEFORE any work — no argon2 hash, no DB write,
 * no privileged BYPASSRLS connection. When the flag is '1' the original
 * behavior is fully restored.
 *
 * This is a white-box controller spec (no live server / DB needed): it drives
 * `AuthController.signup` directly with a SPY `AuthService`, so the assertion
 * "the service was never invoked" IS the no-side-effect proof — if the 404
 * guard is removed, `authService.signup` runs and these tests fail.
 *
 * Mutation check: delete the `if (serverEnv.PUBLIC_SIGNUP_ENABLED !== '1')
 * throw new NotFoundException()` guard and the OFF tests below FAIL (the spy
 * is called + no exception is thrown). The ON test proves the gate is
 * reversible (not a constant 404).
 *
 * Env note: under the API vitest config (SKIP_ENV_VALIDATION=true) `serverEnv`
 * is the live `process.env` object; under validated boot it's a parsed
 * snapshot. Mutating the `serverEnv` property directly works in BOTH modes,
 * so we save/restore it here rather than poking `process.env`.
 */

const FLAG = 'PUBLIC_SIGNUP_ENABLED' as const;

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const env = serverEnv as unknown as Record<string, string | undefined>;
  const had = Object.prototype.hasOwnProperty.call(env, FLAG);
  const prev = env[FLAG];
  if (value === undefined) {
    delete env[FLAG];
  } else {
    env[FLAG] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      env[FLAG] = prev;
    } else {
      delete env[FLAG];
    }
  }
}

/** Minimal stand-in for the parts of AuthService the controller touches. */
function makeServiceSpy() {
  const signup = vi.fn(async () => ({
    accessToken: 'access.jwt.value',
    refreshToken: 'refresh.raw.value',
    user: { id: 'u1', role: 'manager', organization: { id: 'o1' } },
  }));
  const cookies = vi.fn((accessToken: string, refreshToken: string) => ({
    access: { name: 'access_token', value: accessToken, opts: { path: '/' } },
    refresh: { name: 'refresh_token', value: refreshToken, opts: { path: '/api/v1/auth/refresh' } },
  }));
  const service = { signup, cookies } as unknown as AuthService;
  return { service, signup, cookies };
}

function makeReq() {
  return { ip: '203.0.113.7', headers: { 'user-agent': 'vitest' } } as never;
}

function makeRes() {
  const setCookie = vi.fn();
  return { res: { setCookie } as never, setCookie };
}

const DTO: SignupDto = {
  org_name: 'Flag Org',
  name: 'Flag Manager',
  email: 'flag@example.test',
  password: 'TestPassword123456',
} as SignupDto;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthController.signup — PUBLIC_SIGNUP_ENABLED gate', () => {
  it('OFF (flag="0") → throws NotFoundException AND never invokes authService.signup (no side effects)', async () => {
    const { service, signup } = makeServiceSpy();
    const { res, setCookie } = makeRes();
    const controller = new AuthController(service);

    await withFlag('0', async () => {
      await expect(controller.signup(DTO, makeReq(), res)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // No-side-effect proof: the service (argon2 + withBootstrap DB write +
    // BYPASSRLS connection) was NEVER reached, and no auth cookies were set.
    expect(signup).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('OFF (flag unset/undefined) → also 404 (default-off, not "must equal 0")', async () => {
    const { service, signup } = makeServiceSpy();
    const { res } = makeRes();
    const controller = new AuthController(service);

    await withFlag(undefined, async () => {
      await expect(controller.signup(DTO, makeReq(), res)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    expect(signup).not.toHaveBeenCalled();
  });

  it('OFF (flag="true" / any non-"1") → still 404 (strict equality to "1")', async () => {
    const { service, signup } = makeServiceSpy();
    const { res } = makeRes();
    const controller = new AuthController(service);

    for (const v of ['true', 'yes', 'on', '2', '01', ' 1', '']) {
      // eslint-disable-next-line no-await-in-loop
      await withFlag(v, async () => {
        await expect(controller.signup(DTO, makeReq(), res)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });
    }
    expect(signup).not.toHaveBeenCalled();
  });

  it('ON (flag="1") → reaches authService.signup, sets cookies, returns {data:{user}} (gate is reversible)', async () => {
    const { service, signup, cookies } = makeServiceSpy();
    const { res, setCookie } = makeRes();
    const controller = new AuthController(service);

    const result = await withFlag('1', async () => controller.signup(DTO, makeReq(), res));

    // The gate is OPEN: the real onboarding path runs.
    expect(signup).toHaveBeenCalledTimes(1);
    expect(signup).toHaveBeenCalledWith(DTO, '203.0.113.7', 'vitest');
    expect(cookies).toHaveBeenCalledTimes(1);
    expect(setCookie).toHaveBeenCalledTimes(2); // access + refresh
    expect(result).toEqual({
      data: { user: { id: 'u1', role: 'manager', organization: { id: 'o1' } } },
    });
  });

  it('ON (flag="1") + duplicate email → neutral 201 body, no cookies (anti-enumeration intact under the gate)', async () => {
    const { service, signup, cookies } = makeServiceSpy();
    signup.mockResolvedValueOnce({ duplicate: true } as never);
    const { res, setCookie } = makeRes();
    const controller = new AuthController(service);

    const result = await withFlag('1', async () => controller.signup(DTO, makeReq(), res));

    expect(signup).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: { ok: true } });
    // duplicate path must NOT set auth cookies (no session for a non-create).
    expect(cookies).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
  });
});
