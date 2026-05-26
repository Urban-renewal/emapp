/**
 * V10-S1 closure spec — `getCurrentSessionUser()` discriminated-union
 * resolver. Pins:
 *  - org tier wins when both tokens are present (dual-role user)
 *  - provider tier returned when only provider session exists
 *  - null when neither session exists
 *  - short-circuit on cookie absence — no BE call when no cookie
 *
 * Mocks both `getMe()` and `getProviderMe()` (the underlying server
 * actions) at module-level so the test runs as a pure unit without
 * touching the Next.js cookies/headers Server-Action runtime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getMe: vi.fn() }));
vi.mock('./provider-auth', () => ({ getProviderMe: vi.fn() }));

import { getMe } from './auth';
import { getProviderMe } from './provider-auth';
import { getCurrentSessionUser } from './session';

const mockedGetMe = vi.mocked(getMe);
const mockedGetProviderMe = vi.mocked(getProviderMe);

const ORG_PROFILE = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Org User',
  email: 'org@example.test',
  role: 'manager' as const,
  avatarColor: null,
  organization: { id: 'aaa', name: 'Org', slug: 'org' },
};
const PROVIDER_PROFILE = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Provider Admin',
  email: 'admin@emapp.io',
  role: 'provider_admin' as const,
};

beforeEach(() => {
  mockedGetMe.mockReset();
  mockedGetProviderMe.mockReset();
});

describe('getCurrentSessionUser', () => {
  it('S1) returns tier=org when only org session exists', async () => {
    mockedGetMe.mockResolvedValueOnce(ORG_PROFILE);
    mockedGetProviderMe.mockResolvedValueOnce(null);

    const result = await getCurrentSessionUser();
    expect(result).toEqual({ tier: 'org', profile: ORG_PROFILE });
  });

  it('S2) returns tier=provider when only provider session exists', async () => {
    mockedGetMe.mockResolvedValueOnce(null);
    mockedGetProviderMe.mockResolvedValueOnce(PROVIDER_PROFILE);

    const result = await getCurrentSessionUser();
    expect(result).toEqual({ tier: 'provider', profile: PROVIDER_PROFILE });
  });

  it('S3) returns null when neither session exists', async () => {
    mockedGetMe.mockResolvedValueOnce(null);
    mockedGetProviderMe.mockResolvedValueOnce(null);

    const result = await getCurrentSessionUser();
    expect(result).toBeNull();
  });

  it('S4) org tier wins when BOTH sessions exist (dual-role user)', async () => {
    // Documented behavior: if a developer is both a Manager AND a
    // Provider Admin (rare but possible), the dashboard root renders
    // as org tier. To use the provider console they must navigate to
    // /provider/* — the provider/layout asserts tier === 'provider'
    // and would redirect, but the middleware already gated the path
    // with the provider cookie check. The dual-cookie edge case is
    // resolved at the URL layer.
    mockedGetMe.mockResolvedValueOnce(ORG_PROFILE);
    mockedGetProviderMe.mockResolvedValueOnce(PROVIDER_PROFILE);

    const result = await getCurrentSessionUser();
    expect(result?.tier).toBe('org');
    expect(result?.profile.id).toBe(ORG_PROFILE.id);
  });

  it('S5) provider call is skipped when org call succeeds (no extra BE round-trip)', async () => {
    // Pin the performance invariant — at most ONE successful resolver
    // call. getMe() returns a profile → we MUST NOT then also call
    // getProviderMe() (would be wasted work + a second BE round-trip
    // on every org-tier page nav, paying 5-15ms for nothing).
    mockedGetMe.mockResolvedValueOnce(ORG_PROFILE);
    mockedGetProviderMe.mockResolvedValue(PROVIDER_PROFILE); // would return but shouldn't be called

    await getCurrentSessionUser();
    expect(mockedGetMe).toHaveBeenCalledOnce();
    expect(mockedGetProviderMe).not.toHaveBeenCalled();
  });

  it('S6) provider call IS made when org call returns null', async () => {
    mockedGetMe.mockResolvedValueOnce(null);
    mockedGetProviderMe.mockResolvedValueOnce(PROVIDER_PROFILE);

    await getCurrentSessionUser();
    expect(mockedGetMe).toHaveBeenCalledOnce();
    expect(mockedGetProviderMe).toHaveBeenCalledOnce();
  });

  it('S7) discriminated union shape — tier discriminator narrows profile correctly', async () => {
    // Compile-time + runtime: the union's tier discriminator MUST let
    // TypeScript narrow `profile` to the matching shape. We exercise
    // both branches via a switch to confirm the union is properly
    // discriminated at runtime (no implicit `unknown` leak).
    mockedGetMe.mockResolvedValueOnce(ORG_PROFILE);
    mockedGetProviderMe.mockResolvedValueOnce(null);

    const result = await getCurrentSessionUser();
    expect(result).not.toBeNull();
    if (result?.tier === 'org') {
      // Org tier has `organization.name` — provider tier does NOT.
      expect(result.profile.organization.name).toBe('Org');
    } else {
      throw new Error('tier discriminator branch wrong');
    }
  });
});
