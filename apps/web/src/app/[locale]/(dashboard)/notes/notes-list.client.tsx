'use client';

import { useQuery } from '@tanstack/react-query';
import { Pin, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useNoteList } from '@/hooks/use-notes';
import { useHasPermission } from '@/hooks/use-permissions';
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
export function NotesListClient() {
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

  const { data, isLoading, isError, error, refetch } = useNoteList({ limit: 25, cursor }, lookup);
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const canCreate = useHasPermission('notes.create');

  // find-at-scale (3.3) — client-side find over the LOADED keyset page.
  // Controlled input (no native submit → no GET-fallback class) filters the
  // in-memory notes by body OR author name; a one-click "pinned only" chip
  // narrows to the floated-to-top pins. No new fetch — instant. Mirrors the
  // projects/owners search idiom. The existing pinned-first sort is preserved
  // (filter runs over the already-sorted set).
  const [query, setQuery] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((n) => {
      if (pinnedOnly && !n.pinned) return false;
      if (!q) return true;
      if (n.body.toLowerCase().includes(q)) return true;
      const author = n.createdByName ?? n.createdByShort;
      return author.toLowerCase().includes(q);
    });
  }, [items, query, pinnedOnly]);
  const hasActiveFilter = query.trim() !== '' || pinnedOnly;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/notes/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      {/* find-at-scale (3.3) — search + "pinned only" chip. Rendered once
          there are notes to find (loading/error/empty are the shell's job).
          A filter that yields nothing shows the `noResults` copy (distinct
          from the empty-org `empty` copy) via the shell's emptyLabel. */}
      {!isLoading && !isError && items.length > 0 && (
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
          <button
            type="button"
            aria-pressed={pinnedOnly}
            onClick={() => setPinnedOnly((v) => !v)}
            className={
              pinnedOnly
                ? 'inline-flex items-center gap-1.5 rounded-full bg-status-warning-bg px-3 py-1.5 text-xs font-medium text-status-warning-fg'
                : 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted'
            }
          >
            <Pin className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('filterPinned')}</span>
          </button>
        </div>
      )}

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        error={error}
        itemCount={filtered.length}
        page={hasActiveFilter ? undefined : data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={hasActiveFilter ? t('noResults') : t('empty')}
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
          {filtered.map((n) => (
            <li
              key={n.id}
              className={
                n.pinned
                  ? 'rounded-lg border border-status-warning-fg/30 bg-status-warning-bg p-4'
                  : 'rounded-lg border border-border bg-surface p-4'
              }
            >
              <Link href={`/notes/${n.id}`} className="block">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {n.pinned && (
                    <span className="rounded-full bg-status-warning-bg px-2 py-0.5 font-medium text-status-warning-fg">
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
