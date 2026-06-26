'use client';

import { AlertTriangle, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { OwnerStatesSummary } from '@/components/owners/owner-states-summary';
import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useOwnerList, useOwnerSearch } from '@/hooks/use-owners';
import { useHasPermission } from '@/hooks/use-permissions';

/** B1 — debounce window (ms) for the search box → server query. Keeps a fast
 *  typist from firing a `GET /owners/search?q=` per keystroke. The box is a
 *  controlled input (no native submit, so no GET-fallback credential-leak
 *  class — per the DOD-BROWSER-SMOKE trigger). Mirrors the projects list. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * RSC prefetch fan-out (perf-research/01-rsc-waterfall.md §2.2): the
 * interactive body — moved VERBATIM out of `page.tsx`, logic unchanged.
 * On a cold load `useOwnerList` resolves SYNCHRONOUSLY from the dehydrated
 * cache the server `page.tsx` seeded via `<HydrationBoundary>`, so
 * `isLoading` is `false` on first render and NO client `GET /owners` fires.
 * If the server prefetch failed (empty cache), this falls back to its
 * existing loading/error path — the branches below are intact.
 *
 * B1 (findable-at-scale) + B2 (attention-first): at 1000+ owners a flat,
 * creation-ordered wall is unusable. Two additions, both keyset-safe:
 *  - A debounced NAME search box SWAPS the data source to the EXISTING
 *    `GET /owners/search` endpoint (`useOwnerSearch`) when there's a term;
 *    empty box → the normal `useOwnerList`. The search cursor is the same
 *    `createdAt desc, id desc` keyset, so "next page" still works.
 *  - A one-click "צריך טיפול" (needs-attention) chip narrows BOTH the list and
 *    the search to owners with ≥1 pending signature (a BE WHERE predicate, not
 *    a reorder — single round-trip, no N+1), so the manager reaches "who needs
 *    me" without scrolling.
 */
export function OwnersListClient() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Active (default) vs archived view — soft-archived owners are otherwise
  // invisible in the cockpit. Switching resets pagination.
  const [archived, setArchived] = useState(false);
  // B2 — "needs attention" filter (≥1 pending signature). Drives both the list
  // and the search query; toggling resets pagination (a cursor minted under one
  // filter set is meaningless under another).
  const [needsAttention, setNeedsAttention] = useState(false);
  // B1 — `query` is the LIVE controlled-box value; `debouncedQuery` is what
  // drives the server fetch. They diverge only during the debounce window.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // B1 — debounce the search box → server query; reset the cursor when the term
  // changes (a keyset cursor minted for the old term/view is meaningless).
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setCursor(undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // The trimmed term actually searched (empty → list mode). When searching we
  // drop the archived tab (search targets active owners — the BE `searchByName`
  // excludes archived, matching the design that search finds live holdouts).
  const searchTerm = debouncedQuery;
  const isSearching = searchTerm.length > 0;

  // IAM slice 5b — create CTA gated on `owners.create` (UX; BE is authoritative).
  const canCreate = useHasPermission('owners.create');

  // B1 — SWAP the data source: search endpoint when there's a term, else the
  // list. Only ONE query is enabled at a time (the other is `enabled:false`),
  // so exactly one network call fires per state. Both carry VALID params
  // regardless of which is active (the disabled one just never runs).
  const listQuery = useOwnerList({ limit: 25, cursor, archived, needsAttention }, !isSearching);
  const searchQuery = useOwnerSearch(
    { q: searchTerm, limit: 25, cursor, needsAttention },
    isSearching,
  );
  const active = isSearching ? searchQuery : listQuery;
  const { data, isLoading, isError, error, refetch } = active;
  const items = data?.items ?? [];

  const tabs: { key: boolean; label: string }[] = [
    { key: false, label: t('tab.active') },
    { key: true, label: t('tab.archived') },
  ];

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

      {/* Slice 2.5 — the owner legal/life-state situation-picture strip. PII-FREE
          counts (renders nothing when the org has zero active states). */}
      <OwnerStatesSummary />

      {/* B1 — debounced NAME search box. Controlled input (no native submit →
          no GET-fallback credential-leak class). When it has a term the data
          source swaps to GET /owners/search; empty → the normal list. */}
      <div className="relative max-w-md">
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

      {/* Filter row: active/archived tabs (hidden while searching — search
          targets ACTIVE owners) + the one-click "needs attention" chip. */}
      <div className="flex flex-wrap items-center gap-2">
        {!isSearching && (
          <div className="flex gap-1.5" role="tablist" aria-label={t('listTitle')}>
            {tabs.map((tab) => {
              const tabActive = archived === tab.key;
              return (
                <button
                  key={String(tab.key)}
                  type="button"
                  role="tab"
                  aria-selected={tabActive}
                  onClick={() => {
                    if (archived === tab.key) return;
                    setArchived(tab.key);
                    setCursor(undefined);
                  }}
                  className={
                    tabActive
                      ? 'rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background'
                      : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted'
                  }
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}

        {/* B2 — attention-first chip. One click narrows the view to owners with
            ≥1 pending signature (the holdouts that need the manager). Pressed =
            filled amber; reset of the cursor mirrors the tabs. */}
        <button
          type="button"
          aria-pressed={needsAttention}
          onClick={() => {
            setNeedsAttention((v) => !v);
            setCursor(undefined);
          }}
          className={
            needsAttention
              ? 'inline-flex items-center gap-1.5 rounded-full bg-status-warning-bg px-3 py-1 text-xs font-medium text-status-warning-fg'
              : 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted'
          }
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('attention.chip')}</span>
        </button>
      </div>

      {/* At-a-glance summary — in plain words, WHAT the current view shows, so a
          technophobe manager reads one sentence instead of decoding a table. */}
      <p className="text-xs text-muted-foreground" role="status">
        {isSearching
          ? t('attention.summary.search', { count: items.length, term: searchTerm })
          : needsAttention
            ? t('attention.summary.needsAttention', { count: items.length })
            : t('attention.summary.all', { count: items.length })}
      </p>

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        error={error}
        itemCount={items.length}
        page={data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={
          isSearching
            ? t('noResults')
            : needsAttention
              ? t('emptyNeedsAttention')
              : archived
                ? t('emptyArchived')
                : t('empty')
        }
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
                        <span className="rounded-full bg-status-neutral-bg px-2 py-0.5 text-xs font-medium text-status-neutral-fg">
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
                      <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-status-warning-bg px-2 py-0.5 text-xs font-semibold text-status-warning-fg tabular-nums">
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
