'use server';

import { cookies } from 'next/headers';

/**
 * V11 A.S14a — Tenant tier (resident) auth helpers.
 *
 * The tenant flow is **passwordless SMS-OTP**:
 *   1. Phone-entry form POSTs `/api/v1/auth/otp/request` (anti-enum
 *      generic 200 — never reveals whether the phone matches a known
 *      owner).
 *   2. Code-entry form POSTs `/api/v1/auth/otp/verify` which sets the
 *      `tenant_access_token` httpOnly cookie. Both POSTs go through
 *      the same Pages Function reverse-proxy that the org/provider
 *      flows use (D.35) — single env-var surface.
 *
 * The actual POSTs happen client-side via `apiClient.post` (see
 * `(auth)/tenant/login/page.tsx`); this file only provides the
 * **logout** server action, which is a local cookie clear.
 *
 * Why no BE logout endpoint:
 *   - There's no server-side tenant session table — `tenant_access_token`
 *     is a short-lived JWT (OtpService.ACCESS_TTL_SEC). Discarding the
 *     cookie is sufficient; the token will expire on its own.
 *   - Adding a BE logout would require either an audit-only call (no
 *     state to mutate) or a revoke-list (a fresh table). Neither is
 *     in V11 scope. If a future slice adds active-session listing for
 *     the tenant, we'll wire a proper logout then.
 *
 * Why locale-preserving redirect in the LogoutButton (not here):
 *   - This action is locale-agnostic — locale lives in the URL path
 *     and the client component already has `useLocale()` available.
 *   - Same pattern as `logout()` in auth.ts.
 */
export async function logoutTenant(): Promise<{ ok: true }> {
  const cookieStore = await cookies();
  // Cookie was set at path '/' by the BE — `delete()` defaults to root
  // path so the match is correct. Same posture as org `access_token`.
  cookieStore.delete('tenant_access_token');
  return { ok: true };
}
