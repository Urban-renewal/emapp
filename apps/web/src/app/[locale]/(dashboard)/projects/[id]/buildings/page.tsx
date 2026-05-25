'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useBuildingList } from '@/hooks/use-buildings';

export default function BuildingsPage() {
  const t = useTranslations('buildings');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useBuildingList(projectId, { limit: 25, cursor });

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
          <Link href={`/projects/${projectId}/buildings/new`}>{t('create')}</Link>
        </Button>
      </div>

      <p className="text-sm">
        <Link href={`/projects/${projectId}`} className="underline">
          {tp('backToList')}
        </Link>
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((b) => (
            <li key={b.id} className="rounded-md border bg-card p-4">
              <Link href={`/buildings/${b.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold">
                      <NameDisplay name={b.addressLine} />
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('aptCountLabel', { count: b.aptCount })}
                      {b.parcelSummary && <> · {b.parcelSummary}</>}
                      <> · {b.createdRelative}</>
                    </p>
                    {b.isArchived && (
                      <span className="mt-1 inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                        {tp('archived')}
                      </span>
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
