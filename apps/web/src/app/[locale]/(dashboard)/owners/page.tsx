'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useOwnerList } from '@/hooks/use-owners';
import { useHasPermission } from '@/hooks/use-permissions';

export default function OwnersPage() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // IAM slice 5b — create CTA gated on `owners.create` (UX; BE is authoritative).
  const canCreate = useHasPermission('owners.create');
  const { data, isLoading, isError, error, refetch } = useOwnerList({ limit: 25, cursor });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/owners/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        error={error}
        itemCount={items.length}
        page={data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        accessDeniedTitle={tp('accessDeniedTitle')}
        accessDeniedBody={tp('accessDeniedBody')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((o) => (
            <li key={o.id} className="rounded-md border bg-card p-4">
              <Link href={`/owners/${o.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-base font-semibold">
                        <NameDisplay name={o.name} />
                      </h2>
                      {o.isArchived && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {tp('archived')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
                      {t('idLabel')} {o.nationalIdMasked}
                      {o.phoneMasked && (
                        <>
                          {' '}
                          · {t('phoneLabel')} {o.phoneMasked}
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
