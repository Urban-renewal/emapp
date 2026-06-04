import type { OrgStats } from '@emapp/shared-types';
import { CalendarDays, MessageSquare } from 'lucide-react';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { HomeActions } from './_components/home-actions';

/**
 * V11 A.S3 — ManagerHome reskin per
 * `MEAPP_design/design_handoff/source/screens-manager.jsx` ManagerHome.
 * Visual structure landed in this slice:
 *   - Page header (title + subtitle).
 *   - 4-card KPI grid wired to `GET /api/v1/org/stats` (org-wide
 *     aggregates). Active projects / Residents / Signatures received /
 *     Pending — all real numbers. Falls back to "—" if the request
 *     fails so the page never crashes the dashboard.
 *   - Action button "פרויקט חדש" → /projects/new (live, permission-gated
 *     in the `HomeActions` client island). The secondary "משימת שטח"
 *     placeholder was removed (ship-or-hide; Field Tasks is Phase 2).
 *   - Two-column section: WeekCalendar empty state on the left
 *     (will receive real data in A.S12 once B.S6/B.S7 ship the
 *     Calendar service + ICS); Conversations empty state on the
 *     right (chat is Phase 2 deferred).
 *
 * Server Component — fetches stats server-side with the request's
 * own cookies forwarded so RLS / authz applies. Uses cache: no-store
 * to avoid stale numbers between visits.
 */
async function fetchOrgStats(): Promise<OrgStats | null> {
  const cookieHeader = (await cookies()).toString();
  const base = process.env['NEXT_INTERNAL_API_URL'] ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/api/v1/org/stats`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: OrgStats };
    return json.data;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const t = await getTranslations('home');
  const stats = await fetchOrgStats();

  const placeholder = t('kpi.placeholder');
  const fmt = (n: number | undefined): string => (typeof n === 'number' ? String(n) : placeholder);

  const kpis: ReadonlyArray<{
    key: string;
    label: string;
    tone: 'info' | 'success' | 'warning';
    value: string;
  }> = [
    {
      key: 'activeProjects',
      label: t('kpi.activeProjects'),
      tone: 'info',
      value: fmt(stats?.activeProjects),
    },
    {
      key: 'residents',
      label: t('kpi.residents'),
      tone: 'info',
      value: fmt(stats?.residents),
    },
    {
      key: 'signaturesReceived',
      label: t('kpi.signaturesReceived'),
      tone: 'success',
      value: fmt(stats?.signaturesReceived),
    },
    {
      key: 'pending',
      label: t('kpi.pending'),
      tone: 'warning',
      value: fmt(stats?.signaturesPending),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('pageTitle')}
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('pageSubtitle')}
        </p>
      </div>

      {/* KPI grid — 4 cards, equal width */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.key} className="card card-pad">
            <div className="mb-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              {kpi.label}
            </div>
            <div className="flex items-baseline gap-2">
              <div className="text-2xl font-bold tabular" style={{ color: 'var(--text)' }}>
                {kpi.value}
              </div>
              <span className={`badge badge-${kpi.tone}`}>
                <span className="badge-dot" aria-hidden="true" />
                <span>{kpi.value}</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons — IAM slice 5b: permission-gated New Project CTA in a
       *  client island; the disabled "Field Task" placeholder was removed
       *  (ship-or-hide). See `_components/home-actions.tsx`. */}
      <HomeActions />

      {/* Two-column section: WeekCalendar + Conversations (both empty states) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* WeekCalendar empty state */}
        <section className="card" aria-labelledby="home-calendar-heading">
          <div className="card-hd">
            <div className="flex items-center gap-2.5">
              <CalendarDays
                className="h-[18px] w-[18px]"
                style={{ color: 'var(--navy-700)' }}
                aria-hidden="true"
              />
              <h3 id="home-calendar-heading">{t('calendar.title')}</h3>
            </div>
          </div>
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <CalendarDays
              className="h-10 w-10"
              style={{ color: 'var(--text-soft)' }}
              aria-hidden="true"
            />
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
              {t('calendar.empty')}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('calendar.comingHint')}
            </p>
          </div>
        </section>

        {/* Conversations empty state */}
        <section className="card" aria-labelledby="home-conversations-heading">
          <div className="card-hd">
            <div className="flex items-center gap-2">
              <MessageSquare
                className="h-[18px] w-[18px]"
                style={{ color: 'var(--navy-700)' }}
                aria-hidden="true"
              />
              <h3 id="home-conversations-heading">{t('conversations.title')}</h3>
            </div>
          </div>
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <MessageSquare
              className="h-10 w-10"
              style={{ color: 'var(--text-soft)' }}
              aria-hidden="true"
            />
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
              {t('conversations.empty')}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {t('conversations.comingHint')}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
