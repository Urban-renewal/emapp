'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

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
  // IAM slice 5b — the "upload" CTA (starts an import) gated on `imports.run`.
  const canRun = useHasPermission('imports.run');
  const { data, isLoading, isError, refetch } = useImportList({ limit: 25, cursor });

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
        {canRun && (
          <Button asChild>
            <Link href="/imports/new">{t('upload')}</Link>
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((imp) => (
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
