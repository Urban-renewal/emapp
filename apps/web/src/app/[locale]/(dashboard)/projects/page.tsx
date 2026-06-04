'use client';

import { LayoutGrid, List as ListIcon, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useProjectList } from '@/hooks/use-projects';

/**
 * V11 A.S4 — ProjectsList reskin per
 * `MEAPP_design/screens-projects.jsx` ProjectsList function.
 *
 * Filters bar (RTL flex): search input (right-side icon) +
 * cards/table view toggle + primary "פרויקט חדש" button.
 *
 * Two render modes:
 *  - Cards (default): responsive grid of `.card` items. Each card
 *    shows name + status badge + `typeLabel · createdRelative` meta
 *    line + a 3-column placeholder grid for `גוש/חלקה`, `יח״ד`,
 *    `חתימות` that all render the `—` placeholder. The partner
 *    design has agent avatars + contractor name + signed/units
 *    progress; those require BE wire fields the org tier doesn't
 *    expose today (the existing `Project` shape per
 *    `apps/web/src/models/project.vm.ts` is name/type/status/
 *    createdAt/isArchived only). Flagged via
 *    `projects.dataPendingHint` next to the filters bar so a
 *    reviewer knows the dashes are intentional, not a regression.
 *  - Table: `.tbl` (partner class from A.S1) with name / type /
 *    status / updated columns. Same data limits as cards.
 *
 * Search is CLIENT-SIDE filtering over the current page (the BE
 * cursor pagination is unchanged). A real `?q=` server-side search
 * needs a BE slice; the input filters the visible page on `name`,
 * `typeLabel`, and `statusLabel`. The `dataPendingHint` flags this
 * limitation in the UI.
 *
 * Routing / interactions preserved: card / row click navigates to
 * `/projects/[id]`; "פרויקט חדש" goes to `/projects/new`; archive
 * badge still renders for archived projects.
 */
export default function ProjectsPage() {
  const t = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [query, setQuery] = useState('');
  // IAM slice 5b — the "פרויקט חדש" CTA renders only for actors holding
  // `projects.create` (agents/viewers never do → no dead create button).
  const canCreate = useHasPermission('projects.create');
  const { data, isLoading, isError, refetch } = useProjectList({ limit: 25, cursor });

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const page = data?.page;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) => {
      return (
        p.name.toLowerCase().includes(q) ||
        p.typeLabel.toLowerCase().includes(q) ||
        p.statusLabel.toLowerCase().includes(q)
      );
    });
  }, [items, query]);

  if (isLoading) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('loading')}
      </p>
    );
  }
  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters bar (partner ProjectsList lines 13-32) */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="me-auto text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('listTitle')}
        </h1>

        <div className="relative flex-1" style={{ maxWidth: 400, minWidth: 200 }}>
          <Search
            className="pointer-events-none absolute h-4 w-4"
            style={{
              color: 'var(--text-soft)',
              insetInlineEnd: 12,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="input"
            style={{ paddingInlineEnd: 38 }}
          />
        </div>

        {/* Cards/table view toggle (partner ProjectsList lines 27-30) */}
        <div
          role="tablist"
          aria-label={t('listTitle')}
          className="flex gap-0.5 rounded-lg border p-0.5"
          style={{ background: 'var(--bg-subtle)', borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === 'cards'}
            aria-label={t('viewCards')}
            title={t('viewCards')}
            onClick={() => setView('cards')}
            className="flex items-center justify-center rounded-md transition-colors"
            style={{
              padding: '6px 8px',
              background: view === 'cards' ? 'var(--bg-surface)' : 'transparent',
              boxShadow: view === 'cards' ? 'var(--shadow-xs)' : 'none',
              color: view === 'cards' ? 'var(--text)' : 'var(--text-muted)',
            }}
          >
            <LayoutGrid className="h-[15px] w-[15px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'table'}
            aria-label={t('viewTable')}
            title={t('viewTable')}
            onClick={() => setView('table')}
            className="flex items-center justify-center rounded-md transition-colors"
            style={{
              padding: '6px 8px',
              background: view === 'table' ? 'var(--bg-surface)' : 'transparent',
              boxShadow: view === 'table' ? 'var(--shadow-xs)' : 'none',
              color: view === 'table' ? 'var(--text)' : 'var(--text-muted)',
            }}
          >
            <ListIcon className="h-[15px] w-[15px]" aria-hidden="true" />
          </button>
        </div>

        {canCreate && (
          <Link href="/projects/new" className="btn btn-primary">
            <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
            <span>{t('create')}</span>
          </Link>
        )}
      </div>

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('dataPendingHint')}
      </p>

      {/* List */}
      {filteredItems.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {items.length === 0 ? t('empty') : t('noResults')}
        </p>
      ) : view === 'cards' ? (
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}
        >
          {filteredItems.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="card card-pad flex flex-col gap-3 transition-shadow hover:shadow-md focus:outline-none focus-visible:shadow-md"
              style={{ borderColor: 'var(--border)' }}
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div
                    className="truncate text-base font-semibold"
                    style={{ color: 'var(--text)', lineHeight: 1.25 }}
                  >
                    <NameDisplay name={p.name} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <StatusBadge color={p.statusColor}>{p.statusLabel}</StatusBadge>
                    {p.isArchived && (
                      <span className="badge badge-neutral">
                        <span className="badge-dot" aria-hidden="true" />
                        <span>{t('archived')}</span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {p.typeLabel} · {p.createdRelative}
                </div>
              </div>

              {/* 3-col placeholder grid (partner design has real values; we
               *  show `—` until the BE wire is enriched per
               *  `projects.dataPendingHint`). */}
              <div
                className="grid grid-cols-3 gap-1"
                style={{
                  padding: '10px 0',
                  borderTop: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {t('column.gushHelka')}
                  </div>
                  <div
                    className="tabular mt-0.5 text-[13px] font-medium"
                    style={{ color: 'var(--text)' }}
                  >
                    —
                  </div>
                </div>
                <div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {t('column.units')}
                  </div>
                  <div
                    className="tabular mt-0.5 text-[13px] font-medium"
                    style={{ color: 'var(--text)' }}
                  >
                    {p.unitsCount ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {t('column.signatures')}
                  </div>
                  <div
                    className="tabular mt-0.5 text-[13px] font-medium"
                    style={{ color: 'var(--text)' }}
                  >
                    {p.signaturesSignedCount !== undefined && p.signaturesPendingCount !== undefined
                      ? `${p.signaturesSignedCount}/${p.signaturesSignedCount + p.signaturesPendingCount}`
                      : '—'}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('column.name')}</th>
                <th>{t('column.type')}</th>
                <th>{t('column.status')}</th>
                <th>{t('column.updated')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((p) => (
                <tr
                  key={p.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    window.location.assign(`/projects/${p.id}`);
                  }}
                >
                  <td style={{ fontWeight: 600 }}>
                    <Link
                      href={`/projects/${p.id}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: 'var(--text)', textDecoration: 'none' }}
                    >
                      <NameDisplay name={p.name} />
                    </Link>
                    {p.isArchived && (
                      <span className="badge badge-neutral" style={{ marginInlineStart: 8 }}>
                        <span className="badge-dot" aria-hidden="true" />
                        <span>{t('archived')}</span>
                      </span>
                    )}
                  </td>
                  <td className="muted">{p.typeLabel}</td>
                  <td>
                    <StatusBadge color={p.statusColor}>{p.statusLabel}</StatusBadge>
                  </td>
                  <td className="muted text-[12px]">{p.createdRelative}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex flex-wrap items-center gap-2">
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
    </div>
  );
}
