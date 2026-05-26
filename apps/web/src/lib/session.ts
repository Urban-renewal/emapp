'use server';

import type { ProviderProfile, UserProfile } from '@emapp/shared-types';

import { getMe } from './auth';
import { getProviderMe } from './provider-auth';

/**
 * Discriminated union covering both authenticated tiers.
 *
 * Why a union (not separate calls per-layout):
 *  - The dashboard layout is the parent of EVERY authenticated route,
 *    including `/provider/*`. It can't blindly assume org tier — that
 *    was the H1 bug (V10-S1) where the layout's `getMe()` returned
 *    null for Provider Admins and redirected them to `/login` before
 *    `provider/layout.tsx` ever ran.
 *  - With the union, the dashboard layout queries both tiers (cheap —
 *    each call short-circuits on missing cookie; only one BE round-
 *    trip ever fires) and passes the discriminated shape down to
 *    Topbar / Sidebar which render tier-appropriately.
 *
 * Tier isolation is preserved structurally:
 *  - Org session is sourced from `getMe()` (org-tier `access_token`).
 *  - Provider session is sourced from `getProviderMe()` (Provider-tier
 *    `provider_access_token`, audience `emapp-provider`).
 *  - Both cookies CAN coexist on the same browser (different names,
 *    no clash); a user could even be both a manager AND a provider
 *    admin. In that case org tier wins (we check it first) — same
 *    posture as visiting `/` (the dashboard root is org-tier home).
 *    To explicitly view the provider console they navigate to
 *    `/[locale]/provider`, where the middleware enforces the provider
 *    cookie's presence and `provider/layout.tsx` re-asserts the tier.
 */
export type SessionUser =
  | { tier: 'org'; profile: UserProfile }
  | { tier: 'provider'; profile: ProviderProfile };

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
