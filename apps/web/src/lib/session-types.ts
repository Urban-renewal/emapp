import type { ProviderProfile, UserProfile } from '@emapp/shared-types';

/**
 * Discriminated union covering both authenticated tiers.
 *
 * Lives in this plain (non-`'use server'`) module so the type can be
 * exported safely: a `'use server'` module (`session.ts`) must export
 * ONLY async server-action functions — Turbopack's Server-Actions
 * transform tries to register any non-function export as a runtime
 * action, which 500s on a type export. Keeping `SessionUser` here is
 * the structural fix.
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
