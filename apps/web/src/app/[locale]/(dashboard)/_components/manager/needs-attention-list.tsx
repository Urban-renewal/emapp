'use client';

import { AlertCircle, ArrowLeft, CheckCircle2, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { NameDisplay } from '@/components/ui/name-display';

import type { ProjectTriage } from './triage';

/**
 * NeedsAttentionList — "צריך אותך עכשיו": the FEW exception items surfaced from
 * real project data, each a PLAIN Hebrew sentence + exactly ONE action button.
 *
 * North-star principles 2 + 3: plain Hebrew, triage by exception. We show only
 * `near_threshold` (one push from the legal majority) and `not_started`
 * (an active collection still at zero). If there are none, a calm
 * "הכול תחת שליטה" empty state — the relief moment.
 *
 * Token-themed + componentized: the row is presentational; colors come from
 * `--warning-*` / `--success-*` / `--navy-*` tokens, so a designer re-skins
 * each kind by editing tokens. No hex.
 */

const KIND_ICON = {
  near_threshold: AlertCircle,
  not_started: PlayCircle,
} as const;

const KIND_DOT = {
  near_threshold: 'var(--warning-600)',
  not_started: 'var(--navy-500)',
} as const;

function ExceptionRow({ item }: { item: ProjectTriage }) {
  const t = useTranslations('home.manager.needs');
  const kind = item.kind as keyof typeof KIND_ICON;
  const Icon = KIND_ICON[kind];

  // Plain-Hebrew sentence per kind. `near_threshold` always has a numeric gate
  // (that's how it was classified), so the remaining-to-gate count is real.
  const sentence =
    kind === 'near_threshold'
      ? t('nearSentence', { remaining: item.remainingToGate ?? 0 })
      : t('notStartedSentence');

  // ONE action: go straight to the project to act (open the signature flow).
  const actionLabel = kind === 'near_threshold' ? t('nearAction') : t('notStartedAction');

  return (
    <li
      className="flex items-center gap-3 rounded-lg border p-3"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--bg-subtle)', color: KIND_DOT[kind] }}
        aria-hidden="true"
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" style={{ color: 'var(--text)' }}>
          <NameDisplay name={item.project.name} />
        </div>
        <div className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
          {sentence}
        </div>
      </div>
      <Link href={`/projects/${item.project.id}`} className="btn btn-secondary btn-sm shrink-0">
        <span>{actionLabel}</span>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function NeedsAttentionList({ items }: { items: ProjectTriage[] }) {
  const t = useTranslations('home.manager.needs');

  if (items.length === 0) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border p-4"
        style={{ background: 'var(--success-50)', borderColor: 'var(--success-100)' }}
        role="status"
      >
        <CheckCircle2
          className="h-5 w-5 shrink-0"
          style={{ color: 'var(--success-600)' }}
          aria-hidden="true"
        />
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
            {t('emptyTitle')}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('emptyBody')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2" aria-label={t('title')}>
      {items.map((item) => (
        <ExceptionRow key={item.project.id} item={item} />
      ))}
    </ul>
  );
}
