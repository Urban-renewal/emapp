'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { logout } from '@/lib/auth';
import { logoutProvider } from '@/lib/provider-auth';
import { logoutTenant } from '@/lib/tenant-auth';

interface Props {
  /** Discriminates which Server Action to call + which cookies to
   *  clear. Org tier: `/api/v1/auth/logout` + clears access_token /
   *  refresh_token. Provider tier: `/api/v1/provider/auth/logout` +
   *  clears provider_access_token / provider_refresh_token. Tenant
   *  tier (V11 A.S14a): local cookie clear only — no BE endpoint
   *  (passwordless OTP token expires on its own). */
  tier: 'org' | 'provider' | 'tenant';
}

/**
 * Tier-aware logout button — V10-S1 closure (H1 architectural fix).
 *
 * Calls the right Server Action based on the active tier; the action
 * revokes the BE session AND clears the tier-appropriate cookies.
 * After the action returns, `router.refresh()` re-runs the middleware
 * (which now sees no cookie and would redirect on the next
 * navigation); `router.replace()` does the navigation directly so the
 * user sees `/login` immediately rather than a flash of the current
 * page mid-redirect.
 *
 * Why two distinct Server Actions (not one tier-switching shim):
 *  - Each action defensively `.delete()`s cookies at the SPECIFIC
 *    path the BE set (provider_refresh_token is path-scoped to
 *    `/api/v1/provider/auth/refresh`; using the wrong path is a
 *    silent no-op).
 *  - Each action calls a different BE endpoint with a different
 *    audience claim — combining them into one risks accidentally
 *    sending an org cookie to the provider logout endpoint, which
 *    would fail in ways the unified caller can't recover from.
 *
 * Failure handling:
 *  - If the Server Action throws (network down, Server Action runtime
 *    error), the `pending` state clears via the `useTransition`
 *    callback's natural completion. The user can click again. We do
 *    NOT surface an error — the cookies are cleared locally regardless
 *    of upstream success (see logout() / logoutProvider() — they
 *    always clear local cookies, even on upstream failure), so the
 *    client-side state is already "signed out" by the time control
 *    returns.
 *  - §RED-10 — preserve locale on the post-logout redirect.
 */
export function LogoutButton({ tier }: Props) {
  const t = useTranslations('nav');
  const router = useRouter();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      if (tier === 'provider') {
        await logoutProvider();
        router.refresh();
        router.replace(`/${locale}/login`);
        return;
      }
      if (tier === 'tenant') {
        await logoutTenant();
        router.refresh();
        // Tenant tier bounces to /tenant/login (the tenant's own
        // auth surface), NOT the org /login. Each tier returns to
        // its own front door so the post-logout UX matches the
        // tier the user was just in.
        router.replace(`/${locale}/tenant/login`);
        return;
      }
      await logout();
      router.refresh();
      router.replace(`/${locale}/login`);
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? t('loggingOut') : t('logout')}
    </Button>
  );
}
