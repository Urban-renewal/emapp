'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useContractorList } from '@/hooks/use-contractors';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * Contractors list — read=ALL. IAM slice 5b: the "Create" CTA now renders
 * only for actors holding `contractors.create` (no more dead button that
 * 403s for agent/viewer). BE remains authoritative.
 */
export default function ContractorsPage() {
  const t = useTranslations('contractors');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const canCreate = useHasPermission('contractors.create');
  const { data, isLoading, isError, refetch } = useContractorList({ limit: 25, cursor });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/contractors/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        itemCount={items.length}
        page={data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.id} className="rounded-md border bg-card p-4">
              <Link href={`/contractors/${c.id}`} className="block">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold">
                      <NameDisplay name={c.name} />
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      <NameDisplay name={c.contactEmail} />
                      {c.contactPhone && <> · {c.contactPhone}</>}
                    </p>
                    {c.specialty && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        <NameDisplay name={c.specialty} />
                      </p>
                    )}
                  </div>
                  {c.isArchived && (
                    <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {tp('archived')}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
