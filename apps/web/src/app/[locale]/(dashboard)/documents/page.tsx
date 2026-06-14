'use client';

import { FileSignature, FileText, LayoutGrid, List as ListIcon, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useDocumentList } from '@/hooks/use-documents';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * V11 A.S8 — DocsPage reskin per
 * `MEAPP_design/screens-team.jsx` DocsPage (lines 506-570).
 *
 * Same filters-bar pattern as A.S4 ProjectsList:
 *   - Search input + cards/table view toggle + signature-requests
 *     entry pill + primary "העלאת מסמך" button.
 *   - Cards (default) or Table view of documents.
 *
 * Partner DocsPage has 3 visual blocks the reskin doesn't port:
 *   - 4 KPI cards (signed / pending / processing / rejected counts)
 *     — needs an aggregator endpoint that doesn't exist on the wire.
 *   - "Document templates" grid (Send to sign templates) — needs a
 *     templates table that doesn't exist on the wire.
 *   - Per-row "tenant" + "project" columns — the org-tier `Document`
 *     wire today carries only name / type / size / created / archived
 *     (per `apps/web/src/models/document.vm.ts`); per-doc tenant +
 *     project would require a join the wire doesn't expose.
 *
 * Flagged via `documents.dataPendingHint` next to the filters bar.
 * Signature requests get their own entry pill linking to
 * `/signature-requests` (kept as a separate route — unifying the two
 * surfaces into one page would require BE shape changes outside this
 * slice's scope).
 *
 * Client-side search filters the current page on `name` + `typeLabel`
 * (lowercase). Server-side `?q=` needs a BE slice.
 */
export default function DocumentsPage() {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [query, setQuery] = useState('');
  // Active (default) vs archived view — soft-archived docs are otherwise
  // invisible in the cockpit. Switching resets pagination.
  const [archived, setArchived] = useState(false);
  // IAM slice 5b — "upload" CTA (creates a document) gated on `documents.create`.
  const canCreate = useHasPermission('documents.create');
  const { data, isLoading, isError, refetch } = useDocumentList({ limit: 25, cursor, archived });

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const page = data?.page;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (d) => d.name.toLowerCase().includes(q) || d.typeLabel.toLowerCase().includes(q),
    );
  }, [items, query]);

  if (isLoading) return <ListSkeleton rows={6} />;

  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters bar */}
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

        {/* View toggle (partner pattern from A.S4) */}
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

        {/* Active / archived view toggle — archived docs are reachable here. */}
        <div role="tablist" aria-label={t('listTitle')} className="flex gap-1.5">
          {[
            { key: false, label: t('tab.active') },
            { key: true, label: t('tab.archived') },
          ].map((tab) => {
            const isActive = archived === tab.key;
            return (
              <button
                key={String(tab.key)}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  if (archived === tab.key) return;
                  setArchived(tab.key);
                  setCursor(undefined);
                }}
                className="rounded-full px-3 py-1 text-xs font-medium transition-colors"
                style={{
                  background: isActive ? 'var(--text)' : 'var(--bg-surface)',
                  color: isActive ? 'var(--bg-surface)' : 'var(--text-muted)',
                  border: isActive ? 'none' : '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <Link href="/signature-requests" className="btn btn-secondary" title={t('signaturesHint')}>
          <FileSignature className="h-[15px] w-[15px]" aria-hidden="true" />
          <span>{t('signaturesEntry')}</span>
        </Link>

        {canCreate && (
          <Link href="/documents/new" className="btn btn-primary">
            <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
            <span>{t('upload')}</span>
          </Link>
        )}
      </div>

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('dataPendingHint')}
      </p>

      {filteredItems.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {items.length === 0 ? t('empty') : t('noResults')}
        </p>
      ) : view === 'cards' ? (
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
        >
          {filteredItems.map((d) => (
            <Link
              key={d.id}
              href={`/documents/${d.id}`}
              className="card card-pad flex flex-col gap-2 transition-shadow hover:shadow-md focus:outline-none focus-visible:shadow-md"
            >
              <div className="flex items-start gap-3">
                <FileText
                  className="mt-0.5 h-5 w-5 shrink-0"
                  style={{ color: 'var(--navy-700)' }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
                    <NameDisplay name={d.name} />
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {d.typeLabel} · {d.sizeLabel} · {d.createdRelative}
                  </div>
                </div>
                {d.isArchived && (
                  <span className="badge badge-neutral">
                    <span className="badge-dot" aria-hidden="true" />
                    <span>{tp('archived')}</span>
                  </span>
                )}
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
                <th>{t('column.size')}</th>
                <th>{t('column.created')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((d) => (
                <tr
                  key={d.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    window.location.assign(`/documents/${d.id}`);
                  }}
                >
                  <td style={{ fontWeight: 500 }}>
                    <Link
                      href={`/documents/${d.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-2"
                      style={{ color: 'var(--text)', textDecoration: 'none' }}
                    >
                      <FileText
                        className="h-3.5 w-3.5"
                        style={{ color: 'var(--text-muted)' }}
                        aria-hidden="true"
                      />
                      <NameDisplay name={d.name} />
                    </Link>
                    {d.isArchived && (
                      <span className="badge badge-neutral" style={{ marginInlineStart: 8 }}>
                        <span className="badge-dot" aria-hidden="true" />
                        <span>{tp('archived')}</span>
                      </span>
                    )}
                  </td>
                  <td className="muted">{d.typeLabel}</td>
                  <td className="muted tabular">{d.sizeLabel}</td>
                  <td className="muted text-[12px]">{d.createdRelative}</td>
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
            {tp('next')}
          </Button>
        )}
        {cursor && (
          <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            {tp('resetToFirstPage')}
          </Button>
        )}
      </div>
    </div>
  );
}
