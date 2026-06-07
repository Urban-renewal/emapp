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
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useProviderTenants({ limit: 25, cursor, q });
  const items = data?.items ?? [];

  function onSearch(): void {
    const trimmed = searchInput.trim();
    setQ(trimmed.length > 0 ? trimmed : undefined);
    setCursor(undefined); // a new search resets pagination to the first page
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {/* D.45 — Provider-initiated onboarding entry point. */}
        <Button asChild size="sm">
          <Link href="/provider/onboard">{t('createTenant')}</Link>
        </Button>
      </div>

      {/* Name search — no <form> (avoids a GET-fallback surface); Enter or the
          button applies it. A new search resets the cursor to the first page. */}
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSearch();
          }}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="w-full max-w-xs rounded-md border px-3 py-1.5 text-sm"
        />
        <Button size="sm" variant="outline" onClick={onSearch}>
          {t('search')}
        </Button>
        {q && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchInput('');
              setQ(undefined);
              setCursor(undefined);
            }}
          >
            {t('searchClear')}
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
                      {tenant.isSuspended && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                          {t('suspended')}
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
