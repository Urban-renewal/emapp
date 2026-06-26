'use client';

import { AlertTriangle, FileX, Stamp } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useOrgStats } from '@/hooks/use-org-stats';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * 2.6 future-states — the document legal/life-cycle SITUATION-PICTURE strip.
 * PII-FREE counts only (from `GET /org/stats` `documentStates`): how many active
 * docs are expiring soon, legally rejected, or awaiting notarisation. Renders
 * NOTHING when all three are zero — the strip never adds noise to a clean org
 * (no flat wall, calm-by-default).
 *
 * Gated on `projects.read` — the exact permission `GET /org/stats` requires (all
 * org roles hold it; tenant/provider tiers do not), so the fetch never 403s. The
 * counts are org-wide (RLS-scoped by withTenant); the strip is a calm org-level
 * situation-picture, not an agent-scoped one.
 */
export function DocumentStatesSummary() {
  const t = useTranslations('documents.states');
  // `projects.read` is the permission the org/stats endpoint enforces, so gating
  // the fetch on it means we never fire a request that would 403.
  const canRead = useHasPermission('projects.read');
  const { data } = useOrgStats(canRead);
  const ds = data?.documentStates;

  if (!ds) return null;
  const total = ds.docsExpiringSoon + ds.docsRejected + ds.docsAwaitingNotary;
  if (total === 0) return null;

  const chips: {
    key: string;
    label: string;
    value: number;
    icon: typeof AlertTriangle;
    danger?: boolean;
  }[] = [
    {
      key: 'expiring',
      label: t('counts.expiringSoon'),
      value: ds.docsExpiringSoon,
      icon: AlertTriangle,
      danger: true,
    },
    {
      key: 'rejected',
      label: t('counts.rejected'),
      value: ds.docsRejected,
      icon: FileX,
      danger: true,
    },
    {
      key: 'notary',
      label: t('counts.awaitingNotary'),
      value: ds.docsAwaitingNotary,
      icon: Stamp,
    },
  ].filter((c) => c.value > 0);

  return (
    <section
      className="rounded-lg border p-3"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
      aria-label={t('counts.section')}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          {t('counts.heading')}
        </span>
        {chips.map((c) => {
          const Icon = c.icon;
          return (
            <span
              key={c.key}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
              style={{
                background: c.danger ? 'var(--status-danger-bg)' : 'var(--bg-surface)',
                color: c.danger ? 'var(--status-danger-fg)' : 'var(--text-muted)',
                border: '1px solid var(--border)',
              }}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {c.label}
              <span className="tabular" dir="ltr">
                {c.value}
              </span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
