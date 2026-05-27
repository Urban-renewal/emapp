'use client';

import { Bell, Lock, Plug, Settings as SettingsIcon, Users } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { NameDisplay } from '@/components/ui/name-display';

/**
 * V11 A.S10 client island — tab switcher + per-tab content. Lifted
 * out of the page-level Server Component so the Server Component can
 * stay async (session fetch) while the tabs/state remain interactive.
 *
 * Partner partner-jsx structure mirrored:
 *   - Horizontal tab bar (1px bottom border, active = navy underline)
 *   - One <section> per tab body
 *
 * Scope: General tab is wired (org name + slug + user identity); the
 * other 4 tabs are placeholders with `comingSoon` hints, gated behind
 * the dataPendingHint already shown in page.tsx.
 */

interface OrgDisplay {
  id: string;
  name: string;
  slug: string;
}

interface UserDisplay {
  name: string;
  email: string;
  role: string;
}

interface Props {
  user: UserDisplay;
  organization: OrgDisplay | null;
}

type TabId = 'general' | 'team' | 'notifications' | 'integrations' | 'security';

export function SettingsTabs({ user, organization }: Props) {
  const t = useTranslations('settings');
  const [tab, setTab] = useState<TabId>('general');

  const tabs: { id: TabId; label: string; icon: typeof SettingsIcon }[] = [
    { id: 'general', label: t('tab.general'), icon: SettingsIcon },
    { id: 'team', label: t('tab.team'), icon: Users },
    { id: 'notifications', label: t('tab.notifications'), icon: Bell },
    { id: 'integrations', label: t('tab.integrations'), icon: Plug },
    { id: 'security', label: t('tab.security'), icon: Lock },
  ];

  return (
    <>
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label={t('listTitle')}
        className="flex gap-1 overflow-x-auto"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {tabs.map((tabItem) => {
          const active = tab === tabItem.id;
          const Icon = tabItem.icon;
          return (
            <button
              key={tabItem.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(tabItem.id)}
              className="flex items-center gap-2 whitespace-nowrap transition-colors"
              style={{
                padding: '11px 16px',
                fontSize: 13.5,
                fontWeight: active ? 600 : 500,
                background: 'transparent',
                border: 0,
                color: active ? 'var(--navy-900)' : 'var(--text-muted)',
                borderBottom: active ? '2px solid var(--navy-900)' : '2px solid transparent',
                marginBottom: -1,
                cursor: 'pointer',
              }}
            >
              <Icon className="h-[15px] w-[15px]" aria-hidden="true" />
              <span>{tabItem.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab bodies */}
      {tab === 'general' && (
        <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-general-h">
          <h2
            id="set-general-h"
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {t('general.section')}
          </h2>
          <dl
            className="grid grid-cols-[140px_1fr] gap-y-2 text-sm"
            style={{ color: 'var(--text)' }}
          >
            <dt style={{ color: 'var(--text-muted)' }}>{t('general.orgName')}</dt>
            <dd className="font-medium">
              {organization ? <NameDisplay name={organization.name} /> : t('general.noOrg')}
            </dd>
            {organization && (
              <>
                <dt style={{ color: 'var(--text-muted)' }}>{t('general.orgSlug')}</dt>
                <dd className="tabular" dir="ltr">
                  {organization.slug}
                </dd>
              </>
            )}
            <dt style={{ color: 'var(--text-muted)' }}>{t('general.userName')}</dt>
            <dd className="font-medium">
              <NameDisplay name={user.name} />
            </dd>
            <dt style={{ color: 'var(--text-muted)' }}>{t('general.userEmail')}</dt>
            <dd className="break-all" dir="ltr">
              <NameDisplay name={user.email} />
            </dd>
            <dt style={{ color: 'var(--text-muted)' }}>{t('general.userRole')}</dt>
            <dd className="font-medium">{user.role}</dd>
          </dl>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {t('general.readOnlyHint')}
          </p>
        </section>
      )}

      {tab === 'team' && (
        <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-team-h">
          <h2
            id="set-team-h"
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {t('team.section')}
          </h2>
          <p className="text-sm" style={{ color: 'var(--text)' }}>
            {t('team.description')}
          </p>
          <div>
            <Link href="/members" className="btn btn-secondary btn-sm">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('team.openMembers')}</span>
            </Link>
          </div>
        </section>
      )}

      {tab === 'notifications' && (
        <ComingSoonTabBody
          headingId="set-notif-h"
          section={t('notifications.section')}
          description={t('notifications.description')}
          comingSoon={t('comingSoon')}
        />
      )}

      {tab === 'integrations' && (
        <ComingSoonTabBody
          headingId="set-integ-h"
          section={t('integrations.section')}
          description={t('integrations.description')}
          comingSoon={t('comingSoon')}
        />
      )}

      {tab === 'security' && (
        <ComingSoonTabBody
          headingId="set-security-h"
          section={t('security.section')}
          description={t('security.description')}
          comingSoon={t('comingSoon')}
        />
      )}
    </>
  );
}

interface ComingSoonProps {
  headingId: string;
  section: string;
  description: string;
  comingSoon: string;
}

function ComingSoonTabBody({ headingId, section, description, comingSoon }: ComingSoonProps) {
  return (
    <section className="card card-pad flex flex-col gap-3" aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {section}
      </h2>
      <p className="text-sm" style={{ color: 'var(--text)' }}>
        {description}
      </p>
      <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {comingSoon}
      </p>
    </section>
  );
}
