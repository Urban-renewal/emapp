'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileSignature,
  FileText,
  Plus,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useDocumentList } from '@/hooks/use-documents';
import { useHasPermission } from '@/hooks/use-permissions';
import { useDocumentChecklist, useProjectList } from '@/hooks/use-projects';
import type { DocumentViewModel } from '@/models/document.vm';

/**
 * Documents page — "Organized documents" slice (V13).
 *
 * The customer is a technophobic building-committee volunteer: a flat
 * name·type·size·date dump reads as מבולגן even though the BE already
 * organizes docs by project + tracks a required-docs checklist. This page
 * surfaces that organization:
 *   - documents are GROUPED by project (collapsible sections), with an
 *     "ללא שיוך" group for unscoped docs. The `projectId` already rides the
 *     `DocumentViewModel` (no BE change for grouping). Within a project, docs
 *     are sub-grouped by `typeLabel` (doc_type), never a flat dump.
 *   - each project group surfaces the ADVISORY required-docs CHECKLIST +
 *     completeness % (`GET /api/v1/projects/:id/document-checklist`), fetched
 *     lazily per shown group. Missing required types render as quiet chips;
 *     color/filled badges are reserved for that ATTENTION state.
 *   - a plain-Hebrew orientation header states the situation in words.
 *
 * Search stays client-side over the current keyset page (a server-side `?q=`
 * for documents would need a BE slice — out of scope here).
 */
export function DocumentsListClient() {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  // Active (default) vs archived view — soft-archived docs are otherwise
  // invisible in the cockpit. Switching resets pagination.
  const [archived, setArchived] = useState(false);
  // IAM slice 5b — "upload" CTA (creates a document) gated on `documents.create`.
  const canCreate = useHasPermission('documents.create');
  const { data, isLoading, isError, refetch } = useDocumentList({ limit: 25, cursor, archived });

  // Project id → name, so each group header can show the project name rather
  // than a bare id. A miss (project not on the first page) falls back to the
  // id-less "פרויקט" label — the group still renders.
  const { data: projectsData } = useProjectList({ limit: 100 });
  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsData?.items ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsData?.items]);

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const page = data?.page;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (d) => d.name.toLowerCase().includes(q) || d.typeLabel.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Group the shown docs by project; unscoped docs land in their own group.
  // `null` key = the "ללא שיוך" group, always rendered LAST.
  const groups = useMemo(() => {
    const byProject = new Map<string | null, DocumentViewModel[]>();
    for (const d of filteredItems) {
      const key = d.projectId ?? null;
      const bucket = byProject.get(key);
      if (bucket) bucket.push(d);
      else byProject.set(key, [d]);
    }
    const scoped = [...byProject.entries()].filter(([k]) => k !== null) as [
      string,
      DocumentViewModel[],
    ][];
    const unscoped = byProject.get(null);
    return { scoped, unscoped: unscoped ?? [] };
  }, [filteredItems]);

  // Each project group reports its missing-required count up here so the
  // orientation header can state "M מסמכי-חובה חסרים" across the shown groups.
  const [missingByProject, setMissingByProject] = useState<Record<string, number>>({});
  const reportMissing = useCallback((projectId: string, missing: number) => {
    setMissingByProject((prev) =>
      prev[projectId] === missing ? prev : { ...prev, [projectId]: missing },
    );
  }, []);
  const totalMissing = useMemo(
    () => groups.scoped.reduce((sum, [pid]) => sum + (missingByProject[pid] ?? 0), 0),
    [groups.scoped, missingByProject],
  );

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

      {/* Plain-Hebrew orientation — states the situation in words. */}
      {items.length > 0 && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {totalMissing > 0
            ? t('orientation.withMissing', { count: items.length, missing: totalMissing })
            : t('orientation.allClear', { count: items.length })}
        </p>
      )}

      {filteredItems.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {items.length === 0 ? t('empty') : t('noResults')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.scoped.map(([projectId, docs]) => (
            <ProjectDocGroup
              key={projectId}
              projectId={projectId}
              projectName={projectNames.get(projectId) ?? null}
              docs={docs}
              onMissing={reportMissing}
            />
          ))}
          {groups.unscoped.length > 0 && (
            <ProjectDocGroup
              key="__unscoped__"
              projectId={null}
              projectName={null}
              docs={groups.unscoped}
              onMissing={reportMissing}
            />
          )}
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

/**
 * One collapsible project group. Header = project name + the advisory
 * required-docs checklist line; body = the project's docs sub-grouped by
 * doc_type (typeLabel). For the unscoped ("ללא שיוך") group `projectId` is
 * null — no checklist is fetched.
 */
function ProjectDocGroup({
  projectId,
  projectName,
  docs,
  onMissing,
}: {
  projectId: string | null;
  projectName: string | null;
  docs: DocumentViewModel[];
  onMissing: (projectId: string, missing: number) => void;
}) {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');

  // Sub-group by doc_type label, ordered alphabetically for a stable read.
  const byType = useMemo(() => {
    const map = new Map<string, DocumentViewModel[]>();
    for (const d of docs) {
      const bucket = map.get(d.typeLabel);
      if (bucket) bucket.push(d);
      else map.set(d.typeLabel, [d]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'));
  }, [docs]);

  return (
    <details className="card" open style={{ overflow: 'hidden' }}>
      <summary
        className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3"
        style={{ color: 'var(--text)' }}
      >
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform"
          style={{ color: 'var(--text-muted)' }}
          aria-hidden="true"
        />
        <span className="truncate text-sm font-semibold">
          {projectId === null ? (
            t('group.unassigned')
          ) : (
            <NameDisplay name={projectName ?? t('group.projectFallback')} />
          )}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('group.docCount', { count: docs.length })}
        </span>
        {projectId !== null && <ChecklistLine projectId={projectId} onMissing={onMissing} />}
      </summary>

      <div
        className="flex flex-col gap-3 border-t px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        {byType.map(([typeLabel, typeDocs]) => (
          <div key={typeLabel} className="flex flex-col gap-1.5">
            <div
              className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-soft)' }}
            >
              {typeLabel}
            </div>
            <div className="flex flex-col gap-1.5">
              {typeDocs.map((d) => (
                <Link
                  key={d.id}
                  href={`/documents/${d.id}`}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--bg-subtle)] focus:outline-none focus-visible:bg-[var(--bg-subtle)]"
                >
                  <FileText
                    className="h-4 w-4 shrink-0"
                    style={{ color: 'var(--navy-700)' }}
                    aria-hidden="true"
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    style={{ color: 'var(--text)' }}
                  >
                    <NameDisplay name={d.name} />
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {d.sizeLabel} · {d.createdRelative}
                  </span>
                  {d.isArchived && (
                    <span className="badge badge-neutral shrink-0">
                      <span className="badge-dot" aria-hidden="true" />
                      <span>{tp('archived')}</span>
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * The advisory required-docs checklist line inside a project group header.
 * Renders QUIETLY when complete (a calm "כל מסמכי החובה קיימים" with a soft
 * check); reserves color + filled chips for the ATTENTION state (missing
 * required types). On load/error it renders nothing (the group still works) —
 * never a lone "—" that reads as broken.
 */
function ChecklistLine({
  projectId,
  onMissing,
}: {
  projectId: string;
  onMissing: (projectId: string, missing: number) => void;
}) {
  const t = useTranslations('documents');
  const { data: checklist } = useDocumentChecklist(projectId);

  // Report the missing count up for the orientation header (0 when complete).
  // In an effect (never during render) so the parent setState is safe; the
  // parent setter dedupes, so a stable value never loops.
  const missingCount = checklist?.missing.length;
  useEffect(() => {
    if (missingCount !== undefined) onMissing(projectId, missingCount);
  }, [projectId, missingCount, onMissing]);

  if (!checklist || checklist.totalCount === 0) return null;

  if (checklist.isComplete) {
    return (
      <span
        className="ms-auto flex items-center gap-1.5 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <CheckCircle2
          className="h-3.5 w-3.5"
          style={{ color: 'var(--success-600)' }}
          aria-hidden="true"
        />
        {t('checklist.complete')}
      </span>
    );
  }

  return (
    <span
      className="ms-auto flex flex-wrap items-center justify-end gap-1.5 text-xs"
      style={{ color: 'var(--text)' }}
    >
      <AlertTriangle
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--warning-600)' }}
        aria-hidden="true"
      />
      <span style={{ color: 'var(--text-muted)' }}>
        {t('checklist.summary', {
          present: checklist.presentCount,
          total: checklist.totalCount,
        })}
      </span>
      {checklist.missing.map((m) => (
        <span
          key={m.type}
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: 'var(--warning-50)',
            color: 'var(--warning-700)',
            border: '1px solid var(--warning-100)',
          }}
        >
          {m.typeLabel}
        </span>
      ))}
    </span>
  );
}
