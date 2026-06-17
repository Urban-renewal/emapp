import { getTranslations } from 'next-intl/server';

import { NameDisplay } from '@/components/ui/name-display';
import type { SessionUser } from '@/lib/session-types';

import { NotificationsBell } from './notifications-bell';

interface TopbarProps {
  user: SessionUser;
}

/**
 * V11 A.S2 — TopBar reskin per partner shell.jsx (handoff). 64px
 * height, lightweight: org context on the leading side + notifications
 * bell on the trailing side. The user identity + logout moved to the
 * Sidebar footer in this slice (matches the partner design).
 *
 * Tier handling:
 *  - Org tier (manager/agent/viewer/contractor/tenant):
 *      Leading: `organization.name` via `<NameDisplay>`.
 *      Trailing: NotificationsBell (org-tier endpoint).
 *  - Provider tier (provider_admin):
 *      Leading: "EMAPP Provider Console" label (i18n `nav.providerConsole`)
 *      — no org context since the Provider Admin operates cross-tenant.
 *      Trailing: no NotificationsBell — `GET /api/v1/notifications` is
 *      RLS-scoped to a single org; Provider would 403. A future Phase 9
 *      slice could add a provider-tier notification surface
 *      (`provider.audit_alert.*`) — out of scope today.
 *
 * Server Component — uses `getTranslations` server-side and hosts only
 * the interactive children (NotificationsBell) as Client islands.
 */
export async function Topbar({ user }: TopbarProps) {
  const t = await getTranslations('nav');

  const orgLabel = user.tier === 'org' ? user.profile.organization.name : t('providerConsole');

  return (
    <header
      className="sticky top-0 z-10 flex h-16 items-center gap-4 px-6"
      style={{
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold" style={{ color: 'var(--text)' }}>
          <NameDisplay name={orgLabel} />
        </div>
      </div>
      <div className="flex items-center gap-2">{user.tier === 'org' && <NotificationsBell />}</div>
    </header>
  );
}
