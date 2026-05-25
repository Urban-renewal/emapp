'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { useProviderSystemHealth } from '@/hooks/use-provider';
import { cn } from '@/lib/utils';
import type {
  ProviderHealthSeverity,
  ProviderPoolGaugeVM,
  ProviderQueueGaugeVM,
  ProviderR2GaugeVM,
} from '@/models/provider-health.vm';

/**
 * Provider Admin — system health (D.37).
 *
 * Detailed gauges for queue (pg-boss), connection pools (app +
 * provider), and R2 storage. Severity rules locked in
 * `adapters/provider-health.ts`; this page just renders the VM with a
 * colored dot + raw count per metric.
 *
 * No interactive controls — pure read view. The 30s `staleTime` in
 * `useProviderSystemHealth` paired with `refetchOnWindowFocus` keeps
 * the gauges within a minute of truth during active operator use; an
 * explicit "refresh" button below re-fetches immediately.
 */

const SEVERITY_DOT: Record<ProviderHealthSeverity, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  crit: 'bg-red-500',
};

const SEVERITY_BG: Record<ProviderHealthSeverity, string> = {
  ok: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  warn: 'bg-amber-50 text-amber-900 border-amber-200',
  crit: 'bg-red-50 text-red-900 border-red-200',
};

function GaugeDot({ severity, label }: { severity: ProviderHealthSeverity; label: string }) {
  return (
    <span aria-label={label} className="inline-flex items-center gap-1">
      <span className={cn('inline-block h-2 w-2 rounded-full', SEVERITY_DOT[severity])} />
    </span>
  );
}

interface MetricCellProps {
  label: string;
  value: number | string;
  severity: ProviderHealthSeverity;
  severityLabel: string;
}

function MetricCell({ label, value, severity, severityLabel }: MetricCellProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-md border p-3',
        severity === 'ok' ? 'bg-card' : SEVERITY_BG[severity],
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <GaugeDot severity={severity} label={severityLabel} />
        <span>{label}</span>
      </div>
      <p className="text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function QueueSection({
  vm,
  t,
  tSev,
}: {
  vm: ProviderQueueGaugeVM;
  t: ReturnType<typeof useTranslations>;
  tSev: ReturnType<typeof useTranslations>;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{t('queue.title')}</h2>
        <GaugeDot severity={vm.overall} label={tSev(vm.overall)} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MetricCell
          label={t('queue.active')}
          value={vm.active.value}
          severity={vm.active.severity}
          severityLabel={tSev(vm.active.severity)}
        />
        <MetricCell
          label={t('queue.created')}
          value={vm.created.value}
          severity={vm.created.severity}
          severityLabel={tSev(vm.created.severity)}
        />
        <MetricCell
          label={t('queue.retry')}
          value={vm.retry.value}
          severity={vm.retry.severity}
          severityLabel={tSev(vm.retry.severity)}
        />
        <MetricCell
          label={t('queue.failed')}
          value={vm.failed.value}
          severity={vm.failed.severity}
          severityLabel={tSev(vm.failed.severity)}
        />
        <MetricCell
          label={t('queue.completed')}
          value={vm.completed.value}
          severity={vm.completed.severity}
          severityLabel={tSev(vm.completed.severity)}
        />
      </div>
    </section>
  );
}

function PoolSection({
  appPool,
  providerPool,
  t,
  tSev,
}: {
  appPool: ProviderPoolGaugeVM;
  providerPool: ProviderPoolGaugeVM;
  t: ReturnType<typeof useTranslations>;
  tSev: ReturnType<typeof useTranslations>;
}) {
  const renderPool = (label: string, pool: ProviderPoolGaugeVM) => (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <GaugeDot severity={pool.severity} label={tSev(pool.severity)} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MetricCell
          label={t('pool.total')}
          value={pool.total}
          severity="ok"
          severityLabel={tSev('ok')}
        />
        <MetricCell
          label={t('pool.idle')}
          value={pool.idle}
          severity={pool.idle === 0 && pool.total > 0 ? 'warn' : 'ok'}
          severityLabel={tSev(pool.idle === 0 && pool.total > 0 ? 'warn' : 'ok')}
        />
        <MetricCell
          label={t('pool.waiting')}
          value={pool.waiting}
          severity={pool.waiting > 0 ? 'crit' : 'ok'}
          severityLabel={tSev(pool.waiting > 0 ? 'crit' : 'ok')}
        />
      </div>
    </div>
  );

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{t('pool.title')}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {renderPool(t('pool.app'), appPool)}
        {renderPool(t('pool.provider'), providerPool)}
      </div>
    </section>
  );
}

function R2Section({
  vm,
  t,
  tSev,
}: {
  vm: ProviderR2GaugeVM;
  t: ReturnType<typeof useTranslations>;
  tSev: ReturnType<typeof useTranslations>;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{t('r2.title')}</h2>
        <GaugeDot severity={vm.severity} label={tSev(vm.severity)} />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <MetricCell
          label={t('r2.errorsSinceBoot')}
          value={vm.errorsSinceBoot}
          severity={vm.severity}
          severityLabel={tSev(vm.severity)}
        />
        <div className="rounded-md border bg-card p-3">
          <p className="text-xs text-muted-foreground">{t('r2.lastErrorAt')}</p>
          <p className="mt-1 text-sm">
            {vm.lastErrorAt
              ? vm.lastErrorAt.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })
              : t('r2.noErrors')}
          </p>
        </div>
      </div>
    </section>
  );
}

export default function ProviderSystemHealthPage() {
  const t = useTranslations('provider.systemHealth');
  const tSev = useTranslations('provider.dashboard.severity');
  const health = useProviderSystemHealth();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('hint')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => health.refetch()}
          disabled={health.isFetching}
        >
          {health.isFetching ? t('refreshing') : t('refresh')}
        </Button>
      </div>

      {health.isLoading && <ListSkeleton rows={3} />}
      {health.isError && <p className="text-sm text-destructive">{t('loadFailed')}</p>}
      {health.data && (
        <>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <GaugeDot severity={health.data.overall} label={tSev(health.data.overall)} />
            <span>{t('overall', { severity: tSev(health.data.overall) })}</span>
            <span aria-hidden="true">·</span>
            <span>
              {t('asOf', {
                when: health.data.timestamp.toLocaleString('he-IL', {
                  timeZone: 'Asia/Jerusalem',
                }),
              })}
            </span>
          </div>
          <QueueSection vm={health.data.queue} t={t} tSev={tSev} />
          <PoolSection
            appPool={health.data.pool.app}
            providerPool={health.data.pool.provider}
            t={t}
            tSev={tSev}
          />
          <R2Section vm={health.data.r2} t={t} tSev={tSev} />
        </>
      )}
    </div>
  );
}
