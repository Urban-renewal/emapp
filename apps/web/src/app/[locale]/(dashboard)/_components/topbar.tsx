import { getTranslations } from 'next-intl/server';

import { NameDisplay } from '@/components/ui/name-display';
import type { UserProfile } from '@/lib/auth';

import { LogoutButton } from './logout-button';
import { NotificationsBell } from './notifications-bell';

interface TopbarProps {
  user: UserProfile;
}

/**
 * Top bar: org name on the leading side (RTL → right), user identity +
 * role + bell + logout on the trailing side. Server Component — uses
 * the server-side `getTranslations` and hosts two Client children
 * (NotificationsBell + LogoutButton). Avoids hydrating the whole bar
 * when only the interactive parts need to.
 *
 * Phase 4c S3 — the bell is inserted between the identity block and
 * the logout button. It is self-RLS-scoped on the BE side and shows
 * the 5 most recent notifications in a click-toggle popover.
 */
export async function Topbar({ user }: TopbarProps) {
  const t = await getTranslations('nav');

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-6">
      <div className="text-sm font-semibold text-foreground">
        <NameDisplay name={user.organization.name} />
      </div>
      <div className="flex items-center gap-3">
        <div className="text-end">
          <div className="text-sm font-medium leading-tight">
            <NameDisplay name={user.name} />
          </div>
          <div className="text-xs text-muted-foreground">{t(`role.${user.role}`)}</div>
        </div>
        <NotificationsBell />
        <LogoutButton />
      </div>
    </header>
  );
}
