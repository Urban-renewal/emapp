import { getTranslations } from 'next-intl/server';

import type { UserProfile } from '@/lib/auth';

import { LogoutButton } from './logout-button';

interface TopbarProps {
  user: UserProfile;
}

/**
 * Top bar: org name on the leading side (RTL → right), user identity +
 * role + logout on the trailing side. Server Component — uses the
 * server-side `getTranslations` and renders the Client `LogoutButton`
 * as a child. Avoids hydrating the whole bar when only the button is
 * interactive.
 */
export async function Topbar({ user }: TopbarProps) {
  const t = await getTranslations('nav');

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-6">
      <div className="text-sm font-semibold text-foreground">{user.organization.name}</div>
      <div className="flex items-center gap-4">
        <div className="text-end">
          <div className="text-sm font-medium leading-tight">{user.name}</div>
          <div className="text-xs text-muted-foreground">{t(`role.${user.role}`)}</div>
        </div>
        <LogoutButton />
      </div>
    </header>
  );
}
