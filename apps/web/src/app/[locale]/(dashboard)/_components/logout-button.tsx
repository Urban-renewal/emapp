'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { logout } from '@/lib/auth';

/**
 * Logout button — calls the server action that revokes the org session
 * and clears cookies. After the action returns, we router.refresh() so
 * the middleware re-evaluates the missing access_token cookie and the
 * Server Component layout chain renders /login.
 *
 * We don't pre-redirect to /login optimistically — the middleware path
 * is the canonical place for "no cookie → /login", and refresh()
 * triggers it cleanly without a double-navigation flash.
 */
export function LogoutButton() {
  const t = useTranslations('nav');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      await logout();
      router.refresh();
      router.replace('/login');
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? t('loggingOut') : t('logout')}
    </Button>
  );
}
