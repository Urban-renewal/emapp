'use client';

import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useEffect } from 'react';

import { UNAUTHENTICATED_EVENT } from '@/lib/api-client';

/**
 * V11 A.S14b — Tenant-tier mirror of the org `AuthGuard`.
 *
 * The api-client dispatches `emapp:unauthenticated` whenever a portal
 * GET returns 401 with a non-form-level code (e.g. `invalid_token` /
 * `expired_token` minus the silent-refresh-eligible `token_expired`).
 *
 * Without this listener mounted INSIDE the tenant layout, the portal
 * queries would silently land in TanStack's error state and the user
 * would see empty-state copy (or, on a hard failure, a generic error)
 * with no way back to /tenant/login. Mounting the listener here makes
 * the bounce explicit + tier-correct (a tenant 401 returns the resident
 * to their own login page, not the org one).
 *
 * Why a separate component (vs reusing `(dashboard)/AuthGuard`):
 *  - The org AuthGuard reads `pathname.startsWith('/<locale>/provider')`
 *    to pick between org and provider login. Adding a third branch
 *    would muddy that helper; this tenant-specific guard owns the
 *    `/tenant/login` redirect cleanly.
 *  - Tier isolation: the tenant layout is OUTSIDE the dashboard route
 *    group; it doesn't transitively mount any org-tier components.
 */
export function TenantAuthGuard() {
  const router = useRouter();
  const locale = useLocale();

  useEffect(() => {
    function onUnauth() {
      router.replace(`/${locale}/tenant/login`);
    }
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, [router, locale]);

  return null;
}
