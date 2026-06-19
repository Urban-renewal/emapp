'use client';

import { useTranslations } from 'next-intl';

/**
 * Provider Admin — Backups & DR posture (P0.B3).
 *
 * A HONEST, READ-ONLY posture surface — it replaces the old `backups`
 * sidebar stub (href:null/padlock). It deliberately shows **no fabricated
 * backup timestamps**: EMAPP's DB backups are managed by Neon's continuous
 * PITR (there is no app-owned snapshot job whose "last run" we could show),
 * so inventing a "last backup: 03:00" line would be a lie. Instead this page
 * surfaces the *documented managed posture*:
 *   - who manages backups (Neon PITR) + the documented retention window,
 *   - the RTO/RPO commitment,
 *   - the critical PII-key recovery dependency callout,
 *   - a link to the operator runbook (docs/RUNBOOK-backups-dr.md).
 *
 * Everything rendered is a documented constant from the runbook, not a live
 * signal — there is NO backend call and NO new infra. If/when a cheap real
 * read-only signal (e.g. last-migration time, DB connectivity) is wired
 * through a provider endpoint, it can be added here without changing the
 * page's honest framing. Until then we do not pretend to have data we don't.
 *
 * It lives under the provider `layout.tsx`, so the AccessReasonGate + tier
 * check already guard it — no auth is re-implemented here. The page is itself
 * an audited provider surface.
 */

/**
 * Documented retention window (days) for the prod Neon project's history /
 * PITR. This MUST stay in sync with the runbook §2 (`RETENTION_DAYS`). It is
 * the *documented* configured value, not a live read from Neon — labelled as
 * such in the UI so no one mistakes it for a measured signal.
 */
const NEON_RETENTION_DAYS = 7;

/** RTO/RPO commitments — mirror RUNBOOK §1. Documented targets, not measured. */
const RPO_MINUTES = 5;
const RTO_HOURS = 1;

/** Relative path to the operator runbook in the repo. */
const RUNBOOK_PATH = 'docs/RUNBOOK-backups-dr.md';

function PostureRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export default function ProviderBackupsPage() {
  const t = useTranslations('provider.backups');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('hint')}</p>
      </div>

      {/* Managed-by posture — explicitly "managed", no fabricated run times. */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full bg-status-success-fg"
            aria-hidden="true"
          />
          <h2 className="text-base font-semibold">{t('managed.title')}</h2>
        </div>
        <div className="rounded-md border border-border bg-status-success-bg p-3 text-sm text-status-success-fg">
          {t('managed.body', { days: NEON_RETENTION_DAYS })}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <PostureRow
            label={t('posture.retention')}
            value={t('posture.retentionValue', { days: NEON_RETENTION_DAYS })}
          />
          <PostureRow
            label={t('posture.rpo')}
            value={t('posture.rpoValue', { minutes: RPO_MINUTES })}
          />
          <PostureRow
            label={t('posture.rto')}
            value={t('posture.rtoValue', { hours: RTO_HOURS })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('posture.disclaimer')}</p>
      </section>

      {/* Critical PII-key recovery dependency — the keystone callout. */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t('piiKey.title')}</h2>
        <div className="rounded-md border border-border bg-status-warning-bg p-3 text-sm text-status-warning-fg">
          <p className="font-medium">{t('piiKey.warning')}</p>
          <p className="mt-1">{t('piiKey.body')}</p>
        </div>
      </section>

      {/* Restore-drill posture — proven, not assumed. */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t('drill.title')}</h2>
        <div className="rounded-md border bg-card p-3 text-sm">
          <p>{t('drill.body')}</p>
        </div>
      </section>

      {/* Runbook pointer — operator procedure lives in the repo. */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t('runbook.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('runbook.body')}{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" dir="ltr">
            {RUNBOOK_PATH}
          </code>
        </p>
      </section>
    </div>
  );
}
