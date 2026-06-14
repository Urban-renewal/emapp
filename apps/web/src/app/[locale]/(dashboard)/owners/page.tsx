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
        {/* Dense management table — name · identity · apartments · pending
            signatures · action. Replaces the old name-only card list so the
            page is an actionable cockpit, not a roster of names. */}
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5 text-start font-medium">{t('col.name')}</th>
                <th className="px-4 py-2.5 text-start font-medium">{t('col.identity')}</th>
                <th className="px-4 py-2.5 text-center font-medium">{t('col.apartments')}</th>
                <th className="px-4 py-2.5 text-center font-medium">
                  {t('col.pendingSignatures')}
                </th>
                <th className="px-4 py-2.5 text-end font-medium">
                  <span className="sr-only">{t('col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr
                  key={o.id}
                  className="border-b last:border-b-0 transition-colors hover:bg-muted/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/owners/${o.id}`}
                        className="font-semibold hover:underline focus:underline focus:outline-none"
                      >
                        <NameDisplay name={o.name} />
                      </Link>
                      {o.isArchived && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {tp('archived')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                      {o.nationalIdMasked}
                      {o.phoneMasked ? ` · ${o.phoneMasked}` : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center tabular-nums">
                    {o.apartmentCount > 0 ? (
                      o.apartmentCount
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {o.pendingSignatureCount > 0 ? (
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 tabular-nums dark:bg-amber-950 dark:text-amber-200">
                        {o.pendingSignatureCount}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Link
                      href={`/owners/${o.id}`}
                      className="text-xs font-medium text-primary hover:underline focus:underline focus:outline-none"
                    >
                      {t('view')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListPageShell>
    </div>
  );
}
