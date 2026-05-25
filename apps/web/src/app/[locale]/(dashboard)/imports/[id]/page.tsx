'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { computeImportProgressPct } from '@/adapters/import';
import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useImportProgress } from '@/hooks/use-import-progress';
import { useCancelImport, useImport } from '@/hooks/use-imports';
import { ApiClientError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

export default function ImportDetailPage() {
  const t = useTranslations('imports');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useImport(id);
  // Open SSE only for non-terminal imports — terminal rows already
  // carry their final counters; opening a stream against `done`/
  // `failed`/`cancelled` is harmless (server emits `end` immediately)
  // but adds an unnecessary connection.
  const isLiveCandidate = data ? !data.isTerminal : true;
  const sse = useImportProgress(id && isLiveCandidate ? id : undefined);
  const cancel = useCancelImport();
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/imports')}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }
  if (!data) return null;

  // Prefer the live SSE counters if they're fresher than the DB row.
  // SSE 'progress' frames carry id + status + counters; 'end' carries
  // only id + status. For totalRows we fall back to the DB row.
  const live = sse.event;
  const status = live && live.event !== 'gone' ? live.data.status : data.status;
  const counters =
    live && live.event === 'progress'
      ? {
          totalRows: live.data.totalRows,
          processedRows: live.data.processedRows,
          okRows: live.data.okRows,
          failedRows: live.data.failedRows,
        }
      : {
          totalRows: data.totalRows,
          processedRows: data.processedRows,
          okRows: data.okRows,
          failedRows: data.failedRows,
        };
  // §SOLID-L9 — use the single source of truth from the adapter so the
  // live-SSE merge path and the adapter never diverge.
  const progressPct = computeImportProgressPct(counters);

  async function onCancel() {
    if (!id) return;
    setActionError(null);
    if (!window.confirm(t('cancelConfirm'))) return;
    try {
      await cancel.mutateAsync(id);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === 'import_not_cancellable') {
        setActionError(t('notCancellable'));
      } else {
        setActionError(t('cancelFailed'));
      }
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/imports" className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            <NameDisplay name={data.fileName} />
          </h1>
          <div className="flex items-center gap-2">
            <StatusBadge color={data.statusColor}>
              {data.statusLabel}
              {live && live.event !== 'gone' && status !== data.status && (
                <span className="opacity-75"> → {status}</span>
              )}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">{data.fileSizeLabel}</span>
            <span className="text-xs text-muted-foreground">· {data.createdRelative}</span>
            {data.dryRun && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                {t('dryRun')}
              </span>
            )}
          </div>
          {isLiveCandidate && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {sse.connected
                ? t('liveConnected')
                : sse.error === 'stream_closed'
                  ? t('liveLost')
                  : t('liveConnecting')}
            </p>
          )}
        </div>
        {data.isCancellable && (
          <Button variant="outline" size="sm" onClick={onCancel} disabled={cancel.isPending}>
            {cancel.isPending ? t('cancelling') : t('cancel')}
          </Button>
        )}
      </div>

      {/* Progress bar (when totalRows is known) */}
      {progressPct !== null && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {t('processedOfTotal', {
                processed: counters.processedRows,
                total: counters.totalRows ?? 0,
              })}
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">{t('totalRowsLabel')}</dt>
          <dd className="text-base font-semibold">{counters.totalRows ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('processedLabel')}</dt>
          <dd className="text-base font-semibold">{counters.processedRows}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('okLabel')}</dt>
          <dd className="text-base font-semibold text-emerald-700">{counters.okRows}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('failedLabel')}</dt>
          <dd
            className={cn(
              'text-base font-semibold',
              counters.failedRows > 0 ? 'text-destructive' : '',
            )}
          >
            {counters.failedRows}
          </dd>
        </div>
      </dl>

      {data.isAwaitingMapping && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">{t('mappingNeededTitle')}</h2>
          <p className="mt-1 text-sm text-amber-800">{t('mappingNeededHint')}</p>
          <div className="mt-3">
            <Button asChild size="sm">
              <Link href={`/imports/${data.id}/mapping`}>{t('openMappingWizard')}</Link>
            </Button>
          </div>
        </div>
      )}

      {counters.failedRows > 0 && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('errorsSection')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('errorsCount', { count: counters.failedRows })}
          </p>
          <div className="mt-3">
            <Button asChild variant="outline" size="sm">
              <Link href={`/imports/${data.id}/errors`}>{t('viewErrors')}</Link>
            </Button>
          </div>
        </div>
      )}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </div>
  );
}
