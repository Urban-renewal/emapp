'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useEffect } from 'react';

import { UNAUTHENTICATED_EVENT } from '@/lib/api-client';

/**
 * Listens for the `emapp:unauthenticated` event dispatched by api-client
 * when ANY mid-session request returns 401 (token expired, session
 * revoked, refresh failed). Pushes to the tier-appropriate login.
 *
 * Lives once per dashboard layout — mounted alongside the shell, not in
 * every screen — so a single handler covers every fetch inside the
 * authenticated tree.
 *
 * V10-S2 follow-up: tier-aware redirect. The current pathname is the
 * cheapest indicator of which tier session just died — when the user
 * is under `/<locale>/provider/*`, route them to the provider login;
 * otherwise to the org login. Reading the cookie name would be more
 * direct but `document.cookie` is awkward (httpOnly cookies aren't
 * visible) and the URL is already the authoritative tier-context.
 */
export function AuthGuard() {
  const router = useRouter();
  const locale = useLocale();
  const pathname = usePathname();

  useEffect(() => {
    function onUnauth() {
      // §RED-10 — preserve locale on the redirect so the user lands
      // on `/he/login` directly (no `/login` → middleware → `/he/login`
      // double-307 round-trip; also prevents a brief flash of a 404
      // page during the redirect chain).
      const inProviderSubtree = pathname?.startsWith(`/${locale}/provider`) ?? false;
      const target = inProviderSubtree ? `/${locale}/provider/login` : `/${locale}/login`;
      router.replace(target);
    }
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, [router, locale, pathname]);
  return null;
}
