'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useApartmentList } from '@/hooks/use-apartments';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<'gray' | 'amber' | 'emerald' | 'red', string> = {
  gray: 'bg-gray-100 text-gray-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
};

export default function ApartmentsPage() {
  const t = useTranslations('apartments');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const buildingId = params?.id;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useApartmentList(buildingId, {
    limit: 25,
    cursor,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
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
        <Button asChild>
          <Link href={`/buildings/${buildingId}/apartments/new`}>{t('create')}</Link>
        </Button>
      </div>

      <p className="text-sm">
        <Link href={`/buildings/${buildingId}`} className="underline">
          {tp('backToList')}
        </Link>
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id} className="rounded-md border bg-card p-4">
              <Link href={`/apartments/${a.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-base font-semibold">
                        {t('numberPrefix', { number: a.number })}
                      </h2>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_BADGE[a.statusColor],
                        )}
                      >
                        {a.statusLabel}
                      </span>
                      {a.isArchived && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {tp('archived')}
                        </span>
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
