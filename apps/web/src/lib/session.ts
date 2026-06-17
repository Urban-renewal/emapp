'use server';

import { getMe } from './auth';
import { getProviderMe } from './provider-auth';
import type { SessionUser } from './session-types';

/**
 * Resolve the current authenticated session by tier.
 *
 * Performance:
 *  - `getMe()` short-circuits on missing `access_token` cookie (no BE
 *    call). For a Provider Admin who has only `provider_access_token`,
 *    this is one cheap synchronous cookie read.
 *  - `getProviderMe()` short-circuits on missing `provider_access_token`
 *    cookie. For an Org user this is one cheap cookie read.
 *  - Worst case (no cookies at all): two cookie reads, both null, no
 *    BE call — fastest possible redirect-to-login path.
 *  - Best case (single tier): one BE call (the active tier's `/me`).
 *  - There is NO scenario where two BE round-trips fire — the
 *    short-circuit on the cookie name is the gate.
 *
 * Security:
 *  - Each tier's `/me` enforces its own audience check (D.29) at the
 *    BE guard. A malformed/wrong-tier JWT can't masquerade as the
 *    other tier because the audience claim is verified structurally.
 *  - This function never trusts a payload it didn't decode; both
 *    `getMe()` and `getProviderMe()` defensively `.parse()` the
 *    response with their tier's schema.
 *  - Returning null on any failure path is anti-enum (Doc 07 §6.12.1)
 *    — caller maps to a single redirect-to-login.
 */
export async function getCurrentSessionUser(): Promise<SessionUser | null> {
  const orgProfile = await getMe();
  if (orgProfile) return { tier: 'org', profile: orgProfile };

  const providerProfile = await getProviderMe();
  if (providerProfile) return { tier: 'provider', profile: providerProfile };

  return null;
}
