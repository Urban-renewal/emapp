'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useProjectList } from '@/hooks/use-projects';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<'gray' | 'amber' | 'emerald' | 'red', string> = {
  gray: 'bg-gray-100 text-gray-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
};

export default function ProjectsPage() {
  const t = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useProjectList({ limit: 25, cursor });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }
  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {t('retry')}
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
          <Link href="/projects/new">{t('create')}</Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id} className="rounded-md border bg-card p-4">
              <Link href={`/projects/${p.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-base font-semibold">{p.name}</h2>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          STATUS_BADGE[p.statusColor],
                        )}
                      >
                        {p.statusLabel}
                      </span>
                      {p.isArchived && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {t('archived')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.typeLabel} · {p.createdRelative}
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
          {t('next')}
        </Button>
      )}
      {cursor && (
        <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
          {t('resetToFirstPage')}
        </Button>
      )}
    </div>
  );
}
