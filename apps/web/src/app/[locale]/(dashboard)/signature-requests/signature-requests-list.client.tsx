'use client';

import type { SignatureRequestStatus } from '@emapp/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSignatureRequestList } from '@/hooks/use-signature-requests';

const STATUS_FILTERS: (SignatureRequestStatus | 'all')[] = [
  'all',
  'pending',
  'signed',
  'cancelled',
];

/**
 * RSC prefetch fan-out (perf-research/01-rsc-waterfall.md §2.2): the
 * interactive body — moved VERBATIM out of `page.tsx`, logic unchanged. On a
 * cold load `useSignatureRequestList` resolves SYNCHRONOUSLY from the
 * dehydrated cache the server `page.tsx` seeded via `<HydrationBoundary>`, so
 * NO client `GET /signature-requests` fires; on prefetch failure it falls
 * back to its existing `<ListSkeleton>` / error path.
 */
export function SignatureRequestsListClient() {
  const t = useTranslations('signatureRequests');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<SignatureRequestStatus | 'all'>('all');
  // IAM slice 5b — "create" CTA gated on `signature_requests.send`.
  const canCreate = useHasPermission('signature_requests.send');
  const { data, isLoading, isError, refetch } = useSignatureRequestList({
    limit: 25,
    cursor,
    ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
  });

  if (isLoading) return <ListSkeleton rows={6} />;
  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  const items = data?.items ?? [];
  const page = data?.page;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/signature-requests/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            type="button"
            variant={statusFilter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setStatusFilter(s);
              setCursor(undefined);
            }}
          >
            {t(`statusFilter.${s}`)}
          </Button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => (
            <li key={r.id} className="rounded-md border bg-card p-4">
              <Link href={`/signature-requests/${r.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <StatusBadge intent={r.intent}>{r.statusLabel}</StatusBadge>
                      {r.isExpired && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {t('expired')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('createdAt', { rel: r.createdRelative })}
                      {r.status === 'pending' && !r.isExpired && (
                        <> · {t('expiresAt', { rel: r.expiresRelative })}</>
                      )}
                      {r.signedRelative && <> · {t('signedAt', { rel: r.signedRelative })}</>}
                      {r.cancelledRelative && (
                        <> · {t('cancelledAt', { rel: r.cancelledRelative })}</>
                      )}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {page?.has_more && page.cursor && (
        <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor ?? undefined)}>
          {tp('next')}
        </Button>
      )}
      {cursor && (
        <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
          {tp('resetToFirstPage')}
        </Button>
      )}
    </div>
  );
}
