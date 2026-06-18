'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { OrgPulse as OrgPulseData } from './triage';

/**
 * OrgPulse — a compact, calm row of filter-chip stats (NOT 4 big cold metric
 * cards). Each chip is a plain "{n} {word}" pill that deep-links to the
 * filtered /projects list, so the pulse is also a navigation affordance.
 *
 * Token-themed: chips use the app's `--bg-subtle` / `--border` / `--text*`
 * tokens + the shared status accent tokens (`--success-*` / `--warning-*`),
 * so a designer re-skins the whole row by editing those tokens — no hex here.
 *
 * North-star principle 3 (triage by exception at scale): the pulse is the
 * "everything else is fine" reassurance line above the few exceptions, never
 * a metrics dump. Numbers serve words (the Hebrew label is the subject).
 */

type Accent = 'neutral' | 'good' | 'warn';

interface Chip {
  key: string;
  count: number;
  label: string;
  accent: Accent;
  /** /projects deep-link (filter lives on the list page; home stays calm). */
  href: string;
}

const ACCENT_DOT: Record<Accent, string> = {
  neutral: 'var(--navy-500)',
  good: 'var(--success-600)',
  warn: 'var(--warning-600)',
};

export function OrgPulse({ pulse }: { pulse: OrgPulseData }) {
  const t = useTranslations('home.manager.pulse');

  const chips: Chip[] = [
    {
      key: 'active',
      count: pulse.active,
      label: t('active'),
      accent: 'neutral',
      href: '/projects',
    },
    {
      key: 'pastThreshold',
      count: pulse.pastThreshold,
      label: t('pastThreshold'),
      accent: 'good',
      href: '/projects',
    },
    {
      key: 'notStarted',
      count: pulse.notStarted,
      label: t('notStarted'),
      accent: 'warn',
      href: '/projects',
    },
    {
      key: 'gathering',
      count: pulse.gathering,
      label: t('gathering'),
      accent: 'neutral',
      href: '/projects',
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2" role="list" aria-label={t('ariaLabel')}>
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          role="listitem"
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--navy-500)]"
          style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border)' }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: ACCENT_DOT[chip.accent] }}
            aria-hidden="true"
          />
          <span className="tabular font-semibold" style={{ color: 'var(--text)' }}>
            {chip.count}
          </span>
          <span style={{ color: 'var(--text-muted)' }}>{chip.label}</span>
        </Link>
      ))}
    </div>
  );
}
