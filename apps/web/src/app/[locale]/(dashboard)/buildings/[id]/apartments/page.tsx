'use client';

import type { ApartmentStatus } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useApartmentList } from '@/hooks/use-apartments';
import { useHasPermission } from '@/hooks/use-permissions';
import { formatApartmentLabel } from '@/lib/apartment-label';
import { useDisplayLocale } from '@/lib/locale';

// At a real תמ"א-38 building's scale (100-200 apartments) a flat scroll is a
// wall. The status chips let the manager filter SERVER-SIDE to "which need
// attention" (pending) in one click — mirrors the signatures list status-chip
// idiom. 'all' is the default (the prior behaviour); a concrete status ANDs the
// additive BE `status` predicate, keyset-safe. Ordered work-queue-first: the
// statuses that need human attention lead, 'signed' (done) trails.
type ApartmentStatusFilter = ApartmentStatus | 'all';
const STATUS_FILTERS: ApartmentStatusFilter[] = [
  'all',
  'pending',
  'contacted',
  'meeting',
  'signed',
  'refused',
  'unreachable',
];

export default function ApartmentsPage() {
  const t = useTranslations('apartments');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const buildingId = params?.id;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<ApartmentStatusFilter>('all');
  // IAM slice 5b — "add apartment" CTA gated on `apartments.create`.
  const canCreate = useHasPermission('apartments.create');
  const locale = useDisplayLocale();
  const { data, isLoading, isError, refetch } = useApartmentList(buildingId, {
    limit: 25,
    cursor,
    // Additive — omitted for 'all' so the request is byte-identical to before.
    ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
  });

  // Changing the filter re-queries from page 1 (keyset cursors are status-
  // specific; carrying a stale cursor across a filter change is meaningless).
  const selectStatus = (s: ApartmentStatusFilter) => {
    setStatusFilter(s);
    setCursor(undefined);
  };

  const filterChips = (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={t('statusFilterLabel')}
    >
      {STATUS_FILTERS.map((s) => (
        <Button
          key={s}
          type="button"
          variant={statusFilter === s ? 'default' : 'outline'}
          size="sm"
          aria-pressed={statusFilter === s}
          onClick={() => selectStatus(s)}
        >
          {t(`statusFilter.${s}`)}
        </Button>
      ))}
    </div>
  );

  const items = data?.items ?? [];
  const page = data?.page;

  // The header + back-link + status chips are the PERSISTENT shell — they stay
  // mounted across loading / error / empty so the filter row never vanishes
  // mid-click (technophobe lens: the control the manager just used must not
  // disappear under him). Only the result REGION below swaps state.
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href={`/buildings/${buildingId}/apartments/new`}>{t('create')}</Link>
          </Button>
        )}
      </div>

      <p className="text-sm">
        <Link href={`/buildings/${buildingId}`} className="underline">
          {tp('backToList')}
        </Link>
      </p>

      {filterChips}

      {isLoading ? (
        <ListSkeleton rows={6} />
      ) : isError ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {tp('retry')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        statusFilter === 'all' ? (
          // Building has no apartments at all — the "add your first" prompt.
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          // The building HAS apartments, just none in this status — a legible
          // dead-end with a one-click way back to all (technophobe lens).
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('emptyFiltered', { status: t(`statusFilter.${statusFilter}`) })}
            </p>
            <Button variant="outline" size="sm" onClick={() => selectStatus('all')}>
              {t('clearFilter')}
            </Button>
          </div>
        )
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((a) => (
              <li key={a.id} className="rounded-md border bg-card p-4">
                <Link href={`/apartments/${a.id}`} className="block">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        {/* 7c F2 — dedup "דירה דירה 7" (number may already
                            carry the word; formatApartmentLabel decides).
                            FL-9 — append the floor qualifier so same-numbered
                            apartments on different floors are scannable in the
                            list heading ("דירה 1 · קומה 2"), not only buried in
                            the muted facts line below. */}
                        <h2 className="truncate text-base font-semibold">
                          {formatApartmentLabel(a.number, locale === 'he' ? 'דירה' : 'Apartment', {
                            floor: a.floor,
                            floorWord: locale === 'he' ? 'קומה' : 'Floor',
                          })}
                        </h2>
                        <StatusBadge intent={a.intent}>{a.statusLabel}</StatusBadge>
                        {a.isArchived && (
                          <span className="badge badge-neutral">{tp('archived')}</span>
                        )}
                      </div>
                      {a.factsLine && (
                        <p className="mt-1 text-xs text-muted-foreground">{a.factsLine}</p>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

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
        </>
      )}
    </div>
  );
}
