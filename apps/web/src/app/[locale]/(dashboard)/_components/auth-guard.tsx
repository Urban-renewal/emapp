'use client';

import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useEffect } from 'react';

import { UNAUTHENTICATED_EVENT } from '@/lib/api-client';

/**
 * Listens for the `emapp:unauthenticated` event dispatched by api-client
 * when ANY mid-session request returns 401 (token expired, session
 * revoked, refresh failed). Pushes to /login.
 *
 * Lives once per dashboard layout — mounted alongside the shell, not in
 * every screen — so a single handler covers every fetch inside the
 * authenticated tree.
 */
export function AuthGuard() {
  const router = useRouter();
  const locale = useLocale();
  useEffect(() => {
    function onUnauth() {
      // §RED-10 — preserve locale on the redirect so the user lands
      // on `/he/login` directly (no `/login` → middleware → `/he/login`
      // double-307 round-trip; also prevents a brief flash of a 404
      // page during the redirect chain).
      router.replace(`/${locale}/login`);
    }
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, [router, locale]);
  return null;
}
