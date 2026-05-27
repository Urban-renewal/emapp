import { CalendarDays, MessageSquare, Pin, Plus } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * V11 A.S3 — ManagerHome reskin per
 * `MEAPP_design/design_handoff/source/screens-manager.jsx` ManagerHome.
 * Visual structure landed in this slice:
 *   - Page header (title + subtitle).
 *   - 4-card KPI grid (Active projects / Residents / Signatures
 *     received / Pending). Values render as the partner's "—" dash
 *     placeholder until aggregator endpoints exist (Phase 4d or a
 *     dedicated metrics slice — flagged via `home.kpi.comingSoon`).
 *   - Two action buttons: primary "פרויקט חדש" → /projects/new
 *     (live); secondary "משימת שטח" disabled with "בקרוב" hint
 *     (Field Tasks is Phase 2 per docs/03 §1.2).
 *   - Two-column section: WeekCalendar empty state on the left
 *     (will receive real data in A.S12 once B.S6/B.S7 ship the
 *     Calendar service + ICS); Conversations empty state on the
 *     right (chat is Phase 2 deferred).
 *
 * Server Component — uses `getTranslations` server-side; no client
 * state needed at this stage (KPI values are static placeholders).
 */
export default async function HomePage() {
  const t = await getTranslations('home');

  const kpis: ReadonlyArray<{ key: string; label: string; tone: 'info' | 'success' | 'warning' }> =
    [
      { key: 'activeProjects', label: t('kpi.activeProjects'), tone: 'info' },
      { key: 'residents', label: t('kpi.residents'), tone: 'info' },
      { key: 'signaturesReceived', label: t('kpi.signaturesReceived'), tone: 'success' },
      { key: 'pending', label: t('kpi.pending'), tone: 'warning' },
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
              <div
                className="text-2xl font-bold tabular"
                style={{ color: 'var(--text)' }}
                aria-label={t('kpi.comingSoon')}
                title={t('kpi.comingSoon')}
              >
                {t('kpi.placeholder')}
              </div>
              <span className={`badge badge-${kpi.tone}`}>
                <span className="badge-dot" aria-hidden="true" />
                <span>{t('kpi.placeholder')}</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons — primary New Project + secondary Field Task (disabled) */}
      <div className="flex flex-wrap gap-3">
        <Link href="/projects/new" className="btn btn-primary btn-lg">
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{t('action.newProject')}</span>
        </Link>
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t('action.fieldTaskHint')}
          aria-label={`${t('action.fieldTask')} — ${t('action.fieldTaskHint')}`}
          className="btn btn-secondary btn-lg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pin className="h-4 w-4" aria-hidden="true" />
          <span>{t('action.fieldTask')}</span>
        </button>
      </div>

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
