import { getTranslations } from 'next-intl/server';

import { NameDisplay } from '@/components/ui/name-display';
import type { SessionUser } from '@/lib/session';

import { LogoutButton } from './logout-button';
import { NotificationsBell } from './notifications-bell';

interface TopbarProps {
  user: SessionUser;
}

/**
 * Top bar: tier-aware identity surface.
 *
 * Org tier (manager / agent / viewer / contractor / tenant):
 *  - Leading side: org name (`<NameDisplay>`)
 *  - Trailing side: user name + role + bell + logout
 *
 * Provider tier (provider_admin — V10-S1 closure):
 *  - Leading side: "EMAPP Provider Console" label (i18n key
 *    `nav.providerConsole`) — no org context since the Provider Admin
 *    operates cross-tenant.
 *  - Trailing side: user name + role + logout. **No notifications
 *    bell** — `GET /api/v1/notifications` is an org-tier endpoint
 *    (RLS-scoped to a single org); calling it as Provider would 403.
 *    A future Phase 9 slice could add a provider-tier notification
 *    surface (`provider.audit_alert.*`) — out of scope today.
 *
 * Server Component — uses `getTranslations` server-side and hosts only
 * the interactive children as Client islands (NotificationsBell +
 * LogoutButton). The tier discrimination is structural at the component
 * boundary; the Client islands never see the unused tier's data.
 */
export async function Topbar({ user }: TopbarProps) {
  const t = await getTranslations('nav');

  const orgLabel = user.tier === 'org' ? user.profile.organization.name : t('providerConsole');

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-6">
      <div className="text-sm font-semibold text-foreground">
        <NameDisplay name={orgLabel} />
      </div>
      <div className="flex items-center gap-3">
        <div className="text-end">
          <div className="text-sm font-medium leading-tight">
            <NameDisplay name={user.profile.name} />
          </div>
          <div className="text-xs text-muted-foreground">{t(`role.${user.profile.role}`)}</div>
        </div>
        {user.tier === 'org' && <NotificationsBell />}
        <LogoutButton tier={user.tier} />
      </div>
    </header>
  );
}
