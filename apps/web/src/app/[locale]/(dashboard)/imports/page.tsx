'use client';

import { ImportStatusEnum, type ImportStatus } from '@emapp/shared-types';
import { AlertTriangle, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useImportList } from '@/hooks/use-imports';
import { useHasPermission } from '@/hooks/use-permissions';

export default function ImportsPage() {
  const t = useTranslations('imports');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // find-at-scale (3.3) — client-side find over the LOADED keyset page. The box
  // is a CONTROLLED input (no native submit → no GET-fallback credential-leak
  // class) that filters the in-memory `items`; no new network call, so the
  // result is instant. Mirrors the projects/owners search idiom (Search icon
  // inset-end, type="search", aria-label) without the debounce a SERVER query
  // would need. `statusFilter` ('' = all) + a one-click "failures only" chip
  // give the same at-a-glance narrowing the projects status <select> does.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ImportStatus | ''>('');
  const [failuresOnly, setFailuresOnly] = useState(false);
  // IAM slice 5b — the "upload" CTA (starts an import) gated on `imports.run`.
  const canRun = useHasPermission('imports.run');
  const { data, isLoading, isError, refetch } = useImportList({ limit: 25, cursor });

  const allItems = useMemo(() => data?.items ?? [], [data?.items]);

  // The visible set after the client-side find + filters. A "failure" is any
  // import that failed outright OR completed with ≥1 rejected row — the same
  // signal the row's red `failedCount` already surfaces, so the chip and the
  // row stay consistent (single source of truth for "this needs a look").
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allItems.filter((imp) => {
      if (q && !imp.fileName.toLowerCase().includes(q)) return false;
      if (statusFilter && imp.status !== statusFilter) return false;
      if (failuresOnly && imp.status !== 'failed' && imp.failedRows === 0) return false;
      return true;
    });
  }, [allItems, query, statusFilter, failuresOnly]);

  const hasActiveFilter = query.trim() !== '' || statusFilter !== '' || failuresOnly;

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

  const page = data?.page;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canRun && (
          <Button asChild>
            <Link href="/imports/new">{t('upload')}</Link>
          </Button>
        )}
      </div>

      {/* find-at-scale (3.3) — search + status filter + failures-only chip.
          Hidden only when the org has NO imports at all (nothing to find);
          when a filter merely yields no match the controls stay so the user
          can clear it. */}
      {allItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative max-w-md flex-1" style={{ minWidth: 200 }}>
            <Search
              className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              style={{ insetInlineEnd: 12 }}
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              style={{ paddingInlineEnd: 38 }}
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ImportStatus | '')}
            aria-label={t('filter.statusLabel')}
            className="rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{t('filter.statusAll')}</option>
            {ImportStatusEnum.options.map((s) => (
              <option key={s} value={s}>
                {t(`filter.status.${s}`)}
              </option>
            ))}
          </select>

          <button
            type="button"
            aria-pressed={failuresOnly}
            onClick={() => setFailuresOnly((v) => !v)}
            className={
              failuresOnly
                ? 'inline-flex items-center gap-1.5 rounded-full bg-status-warning-bg px-3 py-1.5 text-xs font-medium text-status-warning-fg'
                : 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted'
            }
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('filter.failuresOnly')}</span>
          </button>
        </div>
      )}

      {allItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noResults')}</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((imp) => (
            <li key={imp.id} className="rounded-md border bg-card p-4">
              <Link href={`/imports/${imp.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-base font-semibold">
                        <NameDisplay name={imp.fileName} />
                      </h2>
                      <StatusBadge intent={imp.intent}>{imp.statusLabel}</StatusBadge>
                      {imp.dryRun && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                          {t('dryRun')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {imp.fileSizeLabel}
                      {imp.totalRows !== null && (
                        <>
                          {' '}
                          · {t('rowsLabel', { count: imp.totalRows })}
                          {imp.failedRows > 0 && (
                            <span className="text-destructive">
                              {' '}
                              · {t('failedCount', { count: imp.failedRows })}
                            </span>
                          )}
                        </>
                      )}
                      <> · {imp.createdRelative}</>
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* find-at-scale (3.3) — the client-side filters narrow the LOADED page
          only, so "next page" is hidden while a filter is active (paginating a
          filtered subset would be misleading). Clear the filter to page on. */}
      {!hasActiveFilter && page?.has_more && page.cursor && (
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
