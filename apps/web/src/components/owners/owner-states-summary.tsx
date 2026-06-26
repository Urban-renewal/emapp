'use client';

import { useTranslations } from 'next-intl';

import { useOrgStats } from '@/hooks/use-org-stats';

/**
 * Slice 2.5 — the owner legal/life-state SITUATION-PICTURE strip on the owners
 * list. PII-FREE counts only (from `GET /org/stats` `ownerStates`): how many
 * owners carry an active legal state, and the per-category breakdown. Renders
 * nothing when there are zero — the strip never adds noise to a clean org.
 *
 * `enabled` lets the list skip the fetch for a role that can't read org stats.
 */
export function OwnerStatesSummary({ enabled = true }: { enabled?: boolean }) {
  const t = useTranslations('owners.states.counts');
  const { data } = useOrgStats(enabled);
  const os = data?.ownerStates;

  if (!os || os.ownersWithActiveLegalState === 0) return null;

  const chips: { label: string; value: number; danger?: boolean }[] = [
    { label: t('competency'), value: os.deceasedCount, danger: true },
    { label: t('disputed'), value: os.disputedCount, danger: true },
    { label: t('lien'), value: os.lienCount },
    { label: t('unverified'), value: os.unverifiedCount },
    { label: t('consentWithdrawn'), value: os.consentWithdrawnCount },
  ].filter((c) => c.value > 0);

  return (
    <section
      className="rounded-lg border p-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-soft, transparent)' }}
      aria-label={t('section')}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          {t('withState', { count: os.ownersWithActiveLegalState })}
        </span>
        {chips.map((c) => (
          <span
            key={c.label}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
            style={{
              background: c.danger ? 'var(--danger-100)' : 'var(--surface)',
              color: c.danger ? 'var(--danger-700)' : 'var(--text-muted)',
              border: '1px solid var(--border)',
            }}
          >
            {c.label}
            <span className="tabular" dir="ltr">
              {c.value}
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}
