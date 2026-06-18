'use client';

import { ChevronLeft, Eye } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { useProjectList } from '@/hooks/use-projects';

import { HomeActions } from '../home-actions';

import { MissionGreeting, type TimeOfDay } from './mission-greeting';
import { NeedsAttentionList } from './needs-attention-list';
import { OrgPulse } from './org-pulse';
import { ProjectTriageRow } from './project-triage-row';
import { computeHomeTriage } from './triage';

/**
 * ManagerMissionControl — the client island for the E2.1 manager home
 * (signature mission-control). It is the ONLY client surface; the page shell
 * stays a Server Component and seeds this hook's cache via RSC prefetch
 * (see manager-home.tsx), so on a warm load the list resolves synchronously
 * with no fetch-after-hydration waterfall.
 *
 * IA (docs/DESIGN-NORTH-STAR.md E2.1):
 *   1. MissionGreeting — warm greeting + plain one-line summary.
 *   2. OrgPulse — compact filter-chip stats from REAL project data.
 *   3. "צריך אותך עכשיו" — the few exception items + ONE action each.
 *   4. "דורשים מבט · N מתוך M" — top urgency-ranked projects, calm rows.
 *
 * All triage is derived CLIENT-SIDE from the project list (`computeHomeTriage`,
 * a pure tested fn) — no new endpoint. Honest about gaps: the human "why"
 * layer (owner objection reasons) and the "no movement for X days" duration
 * are OMITTED because the wire doesn't carry them (E2 backend follow-up).
 *
 * `name` is prop-drilled from the RSC (`getMe()`) so the greeting renders with
 * the real actor name on first paint (no client /me round-trip).
 */

const HOME_PROJECT_LIMIT = 100;

function timeOfDay(now: Date): TimeOfDay {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

export function ManagerMissionControl({ name }: { name: string }) {
  const t = useTranslations('home.manager');
  // Pull a wide page so org-wide triage is meaningful (the home shows the few;
  // the full searchable list lives at /projects). 100 is the wire max page.
  const projects = useProjectList({ limit: HOME_PROJECT_LIMIT });

  const items = useMemo(() => projects.data?.items ?? [], [projects.data?.items]);
  const triage = useMemo(() => computeHomeTriage(items), [items]);

  const greeting = (
    <MissionGreeting
      name={name}
      timeOfDay={timeOfDay(new Date())}
      exceptionCount={triage.exceptions.length}
    />
  );

  if (projects.isLoading) {
    return (
      <div className="flex flex-col gap-5">
        {greeting}
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('loading')}
        </p>
      </div>
    );
  }

  if (projects.isError) {
    return (
      <div className="flex flex-col gap-5">
        {greeting}
        <div
          className="rounded-lg border p-4 text-sm"
          style={{
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
            color: 'var(--text-muted)',
          }}
          role="status"
        >
          {t('loadFailed')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Greeting + summary */}
      {greeting}

      {/* Primary action (permission-gated client island, reused as-is). */}
      <HomeActions />

      {/* 2. Org pulse — calm filter-chip stats. */}
      <OrgPulse pulse={triage.pulse} />

      {/* 3. "צריך אותך עכשיו" — the few exceptions, or a calm empty state. */}
      <section aria-labelledby="home-needs-heading" className="flex flex-col gap-2.5">
        <h2
          id="home-needs-heading"
          className="text-sm font-semibold"
          style={{ color: 'var(--text)' }}
        >
          {t('needs.title')}
        </h2>
        <NeedsAttentionList items={triage.exceptions} />
      </section>

      {/* 4. "דורשים מבט · N מתוך M" — urgency-ranked calm rows. */}
      <section aria-labelledby="home-triage-heading" className="card">
        <div className="card-hd">
          <div className="flex items-center gap-2.5">
            <Eye
              className="h-[18px] w-[18px]"
              style={{ color: 'var(--navy-700)' }}
              aria-hidden="true"
            />
            <h2 id="home-triage-heading">
              {t('triage.title', {
                shown: triage.needsAttention.length,
                total: triage.total,
              })}
            </h2>
            <Link
              href="/projects"
              className="me-0 ms-auto inline-flex items-center gap-1 text-xs"
              style={{ color: 'var(--navy-700)' }}
            >
              <span>{t('triage.allProjects', { total: triage.total })}</span>
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div className="card-pad">
          {triage.needsAttention.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('triage.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {triage.needsAttention.map((item) => (
                <ProjectTriageRow key={item.project.id} item={item} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
