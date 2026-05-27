import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getCurrentSessionUser } from '@/lib/session';

import { SettingsTabs } from './_components/settings-tabs';

/**
 * V11 A.S10 — SettingsPage reskin per
 * `MEAPP_design/screens-settings.jsx` SettingsPage (lines 692-748).
 *
 * Partner ships a 6-tab settings surface: כללי / סוכנים / תפקידים /
 * התראות / אינטגרציות / אבטחה. For our app this is a green-field FE
 * surface (no /settings route existed before) — A.S10 is scoped at
 * 0.5 day in MASTER-PLAN-V11, so we ship the tab shell + a single
 * wired tab (General) and stub the rest behind `settings.dataPendingHint`:
 *
 *   - General: org name + slug + user identity, sourced from
 *     `getCurrentSessionUser()` (SSR). Read-only; org rename is a BE
 *     slice that doesn't exist yet.
 *   - Team: short blurb + link to the existing `/members` surface
 *     (A.S9). The partner agents-permissions tab maps onto our
 *     members list; no need to duplicate.
 *   - Notifications / Integrations / Security: scaffolding only —
 *     each needs BE work (notification prefs table, integrations
 *     registry, MFA + session management). Flagged via `dataPendingHint`.
 *
 * Server Component + Client island pattern (similar to layout.tsx):
 *  - This Server Component loads the session via `getCurrentSessionUser()`
 *    and passes the minimal display data into `<SettingsTabs>`.
 *  - `<SettingsTabs>` is the `'use client'` tab switcher.
 *
 * Auth gate: dashboard layout already enforces session presence (and
 * tier separation via middleware). We still call `getCurrentSessionUser()`
 * here to read the organization for the General tab — the layout's
 * call is server-side cached for the request so this isn't a 2nd hop.
 */
export default async function SettingsPage() {
  const session = await getCurrentSessionUser();
  if (!session) redirect('/login');
  // Provider tier never lands here — it has its own /provider surface
  // with its own settings (V10-S1). Defensive redirect: org-only.
  if (session.tier !== 'org') redirect('/provider');

  const t = await getTranslations('settings');

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('listTitle')}
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('subtitle')}
        </p>
      </div>

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('dataPendingHint')}
      </p>

      <SettingsTabs
        user={{
          name: session.profile.name,
          email: session.profile.email,
          role: session.profile.role,
        }}
        organization={'organization' in session.profile ? session.profile.organization : null}
      />
    </div>
  );
}
