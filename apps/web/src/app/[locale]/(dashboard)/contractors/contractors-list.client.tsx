'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useContractorList } from '@/hooks/use-contractors';
import { useHasPermission } from '@/hooks/use-permissions';

/** Debounce window (ms) for the search box → server query, so a fast typist
 *  doesn't fire a `GET /contractors?q=` per keystroke. Same value as the
 *  projects list (the canonical search idiom). The box is a CONTROLLED input
 *  (no native form submit) → no GET-fallback credential-leak class. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Contractors list — read=ALL. IAM slice 5b: the "Create" CTA renders
 * only for actors holding `contractors.create`. BE remains authoritative.
 *
 * FINDABLE AT SCALE (C-1) — at 100+ contractors a flat `<ul>` is an
 * unscannable wall. The manager now FINDS a contractor in ONE action:
 *  - a debounced NAME search box (server-side ILIKE — the BE returns only the
 *    matching page; there is NO client-filter-over-one-page), and
 *  - DATA-DERIVED specialty filter CHIPS. `specialty` is free text (not an
 *    enum), so the chips come from `facets.specialties` the list response
 *    carries — they reflect what actually exists in THIS org, never a hardcoded
 *    set. Picking a chip sends `specialty=` to the server (exact match).
 *
 * This reuses the EXISTING keyset list (no new mechanism) and mirrors the
 * `projects-list.client.tsx` search idiom + the `external_shares` `partyType`
 * filter. Any filter change RESETS the keyset cursor (a cursor minted for one
 * filter set is meaningless under another).
 *
 * "Find the electrician on project X": the manager types the electrician's
 * name (or filters to the חשמל specialty chip) → the matching contractor
 * surfaces on the first page → opens it → sees the shares/projects from the
 * detail surface. No scrolling a wall of 100 cards.
 */
export function ContractorsListClient() {
  const t = useTranslations('contractors');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // `query` is the LIVE controlled-input value; `debouncedQuery` is what drives
  // the server fetch. They diverge only during the debounce window.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [specialty, setSpecialty] = useState<string>('');
  const canCreate = useHasPermission('contractors.create');

  // Debounce the search box → server query. The cursor reset lives here too: a
  // new `q` invalidates any keyset cursor minted for the old `q`.
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setCursor(undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // The trimmed, bounded `q` actually sent (empty → undefined = "no filter", so
  // it drops out of the URL + the query key).
  const q = debouncedQuery.length > 0 ? debouncedQuery : undefined;

  const { data, isLoading, isError, error, refetch } = useContractorList({
    limit: 25,
    cursor,
    q,
    specialty: specialty || undefined,
  });
  const items = data?.items ?? [];
  const specialties = data?.facets.specialties ?? [];
  // True when ANY server filter is active → drives the "no results" vs "no
  // contractors yet" empty-state copy (a search that returns nothing is NOT an
  // empty org).
  const hasActiveFilter = Boolean(q) || specialty !== '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/contractors/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      {/* Find-at-scale toolbar — debounced name search + specialty chips. */}
      <div className="space-y-3">
        <div className="relative" style={{ maxWidth: 400 }}>
          <Search
            className="pointer-events-none absolute h-4 w-4 text-muted-foreground"
            style={{ insetInlineEnd: 12, top: '50%', transform: 'translateY(-50%)' }}
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="input w-full"
            style={{ paddingInlineEnd: 38 }}
          />
        </div>

        {/* Specialty filter chips — DATA-DERIVED from facets.specialties. The
            "all" chip is the calm default (no specialty filter). Hidden entirely
            when the org has no specialties recorded (nothing to filter by). Each
            chip drives the server query + resets the keyset cursor. */}
        {specialties.length > 0 && (
          <div
            role="group"
            aria-label={t('filter.specialtyLabel')}
            className="flex flex-wrap items-center gap-2"
          >
            <button
              type="button"
              aria-pressed={specialty === ''}
              onClick={() => {
                setSpecialty('');
                setCursor(undefined);
              }}
              className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              style={{
                borderColor: specialty === '' ? 'var(--text)' : 'var(--border)',
                background: specialty === '' ? 'var(--text)' : 'var(--bg-surface)',
                color: specialty === '' ? 'var(--bg-surface)' : 'var(--text)',
              }}
            >
              {t('filter.specialtyAll')}
            </button>
            {specialties.map((s) => {
              const active = specialty === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setSpecialty(active ? '' : s);
                    setCursor(undefined);
                  }}
                  className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                  style={{
                    borderColor: active ? 'var(--text)' : 'var(--border)',
                    background: active ? 'var(--text)' : 'var(--bg-surface)',
                    color: active ? 'var(--bg-surface)' : 'var(--text)',
                  }}
                >
                  <NameDisplay name={s} />
                </button>
              );
            })}
          </div>
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
                    <span className="badge badge-neutral shrink-0">{tp('archived')}</span>
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
