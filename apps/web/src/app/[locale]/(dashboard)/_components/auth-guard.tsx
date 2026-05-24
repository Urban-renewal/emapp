'use client';

import { useRouter } from 'next/navigation';
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
  useEffect(() => {
    function onUnauth() {
      router.replace('/login');
    }
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, [router]);
  return null;
}
