'use client';

import {
  ChevronLeft,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Hourglass,
  type LucideIcon,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { NameDisplay } from '@/components/ui/name-display';

import type { ProjectTriage, TriageKind } from './triage';

/**
 * ProjectTriageRow — one calm row in "דורשים מבט": a status icon + project
 * name + a PLAIN momentum/status phrase + a chevron into the project detail.
 *
 * North-star principles 1 + 2: power underneath, calm on top + plain Hebrew.
 * The row is a sentence, not a metrics cell. The momentum phrase is built from
 * REAL counts ("כמעט שם · 14 מתוך 22 · חסרה חתימה אחת") and NEVER fabricates
 * the "X days no movement" duration the wire can't supply (see triage.ts).
 *
 * Token-themed: the per-kind accent is a token (`--success-*` / `--warning-*` /
 * `--navy-*`), so a re-skin is token-only. The whole row is one <Link> →
 * progressive disclosure (the full power lives on the project page).
 */

const KIND_ICON: Record<TriageKind, LucideIcon> = {
  past_threshold: TrendingUp,
  near_threshold: CircleDot,
  not_started: CircleDashed,
  in_progress: CircleDot,
  completed: CircleCheck,
  pre_collection: Hourglass,
  cancelled: CircleDashed,
};

const KIND_COLOR: Record<TriageKind, string> = {
  past_threshold: 'var(--success-600)',
  near_threshold: 'var(--warning-600)',
  not_started: 'var(--navy-500)',
  in_progress: 'var(--navy-500)',
  completed: 'var(--success-600)',
  pre_collection: 'var(--text-soft)',
  cancelled: 'var(--text-soft)',
};

/**
 * Plain-Hebrew momentum phrase for a row. Counts are appended only when REAL
 * (signed + total present). The leading clause is the human status; the trailing
 * "· N מתוך M" is the honest progress.
 */
function useMomentumPhrase(item: ProjectTriage): string {
  const t = useTranslations('home.manager.triage');
  const { kind, signed, total, remainingToGate } = item;

  const counts = signed !== null && total !== null ? t('counts', { signed, total }) : null;

  switch (kind) {
    case 'past_threshold':
      return join(t('pastThreshold'), counts);
    case 'near_threshold':
      // remainingToGate is real here (numeric gate is how it was classified).
      return join(t('nearThreshold', { remaining: remainingToGate ?? 0 }), counts);
    case 'not_started':
      return join(t('notStarted'), counts);
    case 'in_progress':
      return join(t('inProgress'), counts);
    case 'completed':
      return join(t('completed'), counts);
    case 'pre_collection':
      return t('preCollection');
    case 'cancelled':
      return t('cancelled');
    default:
      return '';
  }
}

function join(head: string, tail: string | null): string {
  return tail ? `${head} · ${tail}` : head;
}

export function ProjectTriageRow({ item }: { item: ProjectTriage }) {
  const Icon = KIND_ICON[item.kind];
  const phrase = useMomentumPhrase(item);

  return (
    <li>
      <Link
        href={`/projects/${item.project.id}`}
        className="flex items-center gap-3 rounded-lg p-2.5 transition-colors hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--navy-500)]"
      >
        <Icon
          className="h-[18px] w-[18px] shrink-0"
          style={{ color: KIND_COLOR[item.kind] }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
            <NameDisplay name={item.project.name} />
          </div>
          <div className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
            {phrase}
          </div>
        </div>
        <ChevronLeft
          className="h-4 w-4 shrink-0"
          style={{ color: 'var(--text-soft)' }}
          aria-hidden="true"
        />
      </Link>
    </li>
  );
}
