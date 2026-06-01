'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useProviderTenants } from '@/hooks/use-provider';

/**
 * Provider Admin — tenants list.
 *
 * Each row links to `/provider/tenants/[id]` (detail page lands in S2).
 * Counts shown verbatim; archive badge per D.07.
 *
 * Security: list endpoint returns NO PII at the tenant-level — just org
 * metadata + counts (D.37). Sample owners (masked) come on the detail
 * page only.
 */
export default function ProviderTenantsPage() {
  const t = useTranslations('provider.tenants');
  const tp = useTranslations('projects'); // borrows: archived / next / resetToFirstPage labels
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useProviderTenants({ limit: 25, cursor });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {/* D.45 — Provider-initiated onboarding entry point. */}
        <Button asChild size="sm">
          <Link href="/provider/onboard">{t('createTenant')}</Link>
        </Button>
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
          {items.map((tenant) => (
            <li key={tenant.id} className="rounded-md border bg-card p-4">
              <Link href={`/provider/tenants/${tenant.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-base font-semibold">
                        <NameDisplay name={tenant.name} />
                      </h2>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                        {tenant.slug}
                      </span>
                      {tenant.isArchived && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {tp('archived')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('countsLine', {
                        users: tenant.userCount,
                        projects: tenant.projectCount,
                        owners: tenant.ownerCount,
                      })}
                      <> · {tenant.createdRelative}</>
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
