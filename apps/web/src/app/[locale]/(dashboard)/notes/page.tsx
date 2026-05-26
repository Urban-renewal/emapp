'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useNoteList } from '@/hooks/use-notes';
import { listMembers } from '@/lib/api/members';
import { useDisplayLocale } from '@/lib/locale';

/**
 * Notes list — D.17 read=ALL (every org role; Viewer gets read-only;
 * Agent + Manager can also create). Pinned notes float to the top
 * (FE-side sort — the BE returns `createdAt DESC` only).
 *
 * Side-loads /members for Manager-only name enrichment (same pattern
 * as project-assignments / tasks); Agent/Viewer see the createdBy
 * short-id fallback.
 */
export default function NotesPage() {
  const t = useTranslations('notes');
  const tp = useTranslations('projects');
  const locale = useDisplayLocale();
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const membersQuery = useQuery({
    queryKey: ['members', 'list', { limit: 100 }, locale, 'notes-side-load'],
    queryFn: () => listMembers({ limit: 100 }),
    staleTime: 30_000,
    retry: false,
  });
  const lookup = useMemo<Map<string, AssignmentMemberLookup> | undefined>(() => {
    if (!membersQuery.data) return undefined;
    const m = new Map<string, AssignmentMemberLookup>();
    for (const item of membersQuery.data.items) {
      m.set(item.userId, { name: item.name, email: item.email });
    }
    return m;
  }, [membersQuery.data]);

  const { data, isLoading, isError, refetch } = useNoteList({ limit: 25, cursor }, lookup);
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        <Button asChild>
          <Link href="/notes/new">{t('create')}</Link>
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
          {items.map((n) => (
            <li
              key={n.id}
              className={
                n.pinned
                  ? 'rounded-md border border-amber-300 bg-amber-50 p-4'
                  : 'rounded-md border bg-card p-4'
              }
            >
              <Link href={`/notes/${n.id}`} className="block">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {n.pinned && (
                    <span className="rounded-full bg-amber-200 px-2 py-0.5 font-medium text-amber-900">
                      {t('pinned')}
                    </span>
                  )}
                  <span>
                    {n.createdByName ? (
                      <NameDisplay name={n.createdByName} />
                    ) : (
                      <span className="font-mono" dir="ltr">
                        {t('byUser')} {n.createdByShort}
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{n.createdRelative}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  <NameDisplay name={n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body} />
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
