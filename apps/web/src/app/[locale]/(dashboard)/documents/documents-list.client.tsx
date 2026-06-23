'use client';

import type { DocumentParty, PartyCompleteness } from '@emapp/shared-types';
import {
  ArrowRight,
  Building2,
  Check,
  ClipboardCheck,
  Compass,
  Download,
  FileSignature,
  FileText,
  Files,
  HardHat,
  Plus,
  Ruler,
  Scale,
  Search,
  Upload,
  UserCheck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ComponentType, useEffect, useMemo, useState } from 'react';

import { DOCUMENT_TYPE_LABELS_EN, DOCUMENT_TYPE_LABELS_HE } from '@/adapters/document';
import { isStepUpCancelled, useStepUpUnlock } from '@/components/step-up-unlock';
import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  useArchiveDocument,
  useBoardCompleteness,
  useDocumentList,
  useDocumentSearch,
  useDownloadDocument,
} from '@/hooks/use-documents';
import { useHasPermission } from '@/hooks/use-permissions';
import { useProjectList } from '@/hooks/use-projects';
import { DOCUMENT_PARTIES, providerPartyForDocType } from '@/lib/document-party';
import { formatRelative } from '@/lib/format';
import { useDisplayLocale } from '@/lib/locale';
import type { DocumentViewModel } from '@/models/document.vm';
import type { ProjectViewModel } from '@/models/project.vm';

/**
 * Documents page — server-backed PARTY-BINDER situation-picture board
 * (DOCUMENTS-REMEDIATION-PLAN Phase 2a). Mirrors the signatures 3-tier board
 * (`signature-requests-list.client.tsx`), REUSING `<DataState>` for the calm
 * non-happy states and the same view-toggle UX.
 *
 * This REPLACES the earlier partial re-skin whose counts/gists/search/zoom-in
 * all derived from ONE 25-doc keyset page (so counts lied at scale, a party
 * with >25 docs was silently truncated, search filtered only the loaded 25, and
 * the surface bore zero actions). Now:
 *
 *   • Tier 1 — the PARTY board ("לפי גורם", default). Cards render from the
 *     SERVER board-summary (`useBoardCompleteness` → per-party whole-board
 *     `total` / `latestType` / `latestCreatedAt` + required-vs-received
 *     completeness), NOT a page slice — the counts are truthful at any scale.
 *     Parties with an UNMET requirement (or a ghost gap) rank FIRST
 *     (attention-first); complete/calm parties sit below.
 *   • Tier 2 — the PROJECT board ("לפי פרויקט"). The multi-project manager's
 *     mental model: every in-scope project as a zoom-in tile (server order),
 *     drilling into that project's own documents via `useDocumentList({
 *     projectId })` — server-paginated, never a truncated bucket.
 *   • "כל המסמכים" — the flat forensic list of every document, server-
 *     paginated, legible rows (type + project + apartment + quiet size/date).
 *
 *   • SERVER SEARCH (`useDocumentSearch`, debounced) — a non-empty query box
 *     replaces the active view with REAL server-side results across the whole
 *     board, never a client filter over one loaded page.
 *
 *   • ACTIONS on the surface — an incomplete/ghost party card carries a one-
 *     click "העלה {missing}" deep-link to /documents/new?type=&party= (Phase 2d
 *     honors the params); every file row carries quick download + archive
 *     (`useDownloadDocument` / `useArchiveDocument`).
 */

/** Per-party icon. Color is reserved for ATTENTION only — the icon tile is
 *  tinted, never the whole card. */
const PARTY_META: Record<
  DocumentParty,
  { icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }
> = {
  owner: { icon: Users },
  appraiser: { icon: UserCheck },
  architect: { icon: Compass },
  municipality: { icon: Building2 },
  contractor: { icon: HardHat },
  lawyer: { icon: Scale },
  supervisor: { icon: ClipboardCheck },
  surveyor: { icon: Ruler },
  other: { icon: Files },
};

/** The three situation-picture views. `party` (default) = the binder board
 *  ranked attention-first; `project` = every project as a zoom-in tile;
 *  `all` = the flat forensic list of every document. Mirrors the signatures
 *  `attention | fleet | all` toggle. */
type DocView = 'party' | 'project' | 'all';
const DOC_VIEWS: DocView[] = ['party', 'project', 'all'];

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 25;

export function DocumentsListClient() {
  const t = useTranslations('documents');

  const [view, setView] = useState<DocView>('party');
  // Active (default) vs archived view — soft-archived docs are otherwise
  // invisible in the cockpit. The toggle applies to every view + search.
  const [archived, setArchived] = useState(false);
  // The raw search box value + its debounced counterpart (the actual query
  // that hits the server). A non-empty debounced query takes over the surface.
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setQuery(rawQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  // IAM slice 5b — "upload" CTA (creates a document) gated on `documents.create`.
  const canCreate = useHasPermission('documents.create');

  const searching = query.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Title + search + archived toggle + primary CTAs. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="me-auto text-lg font-semibold text-foreground">{t('listTitle')}</h1>

        <div className="relative flex-1" style={{ maxWidth: 400, minWidth: 200 }}>
          <Search
            className="pointer-events-none absolute h-4 w-4 text-text-soft"
            style={{ insetInlineEnd: 12, top: '50%', transform: 'translateY(-50%)' }}
            aria-hidden="true"
          />
          <input
            type="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="input"
            style={{ paddingInlineEnd: 38 }}
          />
        </div>

        {/* Active / archived view toggle — archived docs are reachable here. */}
        <div role="tablist" aria-label={t('tab.active')} className="flex gap-1.5">
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

      {/* When the search box is non-empty the surface becomes the server search
          results (across the whole board), not the view board. */}
      {searching ? (
        <SearchResults query={query} archived={archived} canCreate={canCreate} />
      ) : (
        <>
          {/* View toggle: לפי גורם (default) | לפי פרויקט | כל המסמכים. */}
          <div
            role="tablist"
            aria-label={t('views.label')}
            className="flex flex-wrap items-center gap-2"
          >
            {DOC_VIEWS.map((v) => (
              <Button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                variant={view === v ? 'default' : 'outline'}
                size="sm"
                onClick={() => setView(v)}
              >
                {t(`views.${v}`)}
              </Button>
            ))}
          </div>

          {view === 'party' && <PartyBoard archived={archived} canCreate={canCreate} />}
          {view === 'project' && <ProjectBoard archived={archived} canCreate={canCreate} />}
          {view === 'all' && <FlatDocumentList archived={archived} canCreate={canCreate} />}
        </>
      )}
    </div>
  );
}

// ── Tier 1 — the PARTY board ────────────────────────────────────────────────

/**
 * The party board — cards from the SERVER board-summary, ranked attention-first.
 * Each card's headline count is the whole-board `total` (truthful at scale), its
 * gist is the latest doc + completeness, and an incomplete/ghost party surfaces a
 * one-click "העלה {missing}" deep-link. Clicking a party with documents zooms in
 * (server-paginated). A loading/errored summary routes through `<DataState>`.
 */
function PartyBoard({ archived, canCreate }: { archived: boolean; canCreate: boolean }) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const { data, isLoading, isError, refetch } = useBoardCompleteness();
  // The zoomed-in party (null = the board). Archived flips reset the zoom.
  const [activeParty, setActiveParty] = useState<DocumentParty | null>(null);
  useEffect(() => setActiveParty(null), [archived]);

  // Rank: attention-first. A party "needs attention" when it has an UNMET
  // requirement OR is a ghost (zero docs). Within each band, keep the canonical
  // board order (stable read). Complete / calm parties sit below.
  const ranked = useMemo<PartyCompleteness[]>(() => {
    const byParty = new Map<DocumentParty, PartyCompleteness>();
    for (const c of data?.byParty ?? []) byParty.set(c.party, c);
    const ordered = DOCUMENT_PARTIES.map((p) => byParty.get(p)).filter(
      (c): c is PartyCompleteness => Boolean(c),
    );
    const needsAttention = (c: PartyCompleteness) =>
      (c.hasRequirement && !c.isComplete) || c.total === 0;
    return [...ordered].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  }, [data?.byParty]);

  const active = activeParty ? (data?.byParty.find((c) => c.party === activeParty) ?? null) : null;

  if (active) {
    return (
      <PartyZoomIn
        completeness={active}
        archived={archived}
        canCreate={canCreate}
        onBack={() => setActiveParty(null)}
      />
    );
  }

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      error={undefined}
      isEmpty={Boolean(data && ranked.every((c) => c.total === 0 && !c.hasRequirement))}
      onRetry={() => void refetch()}
      skeleton="list"
      emptyTitle={t('empty')}
      emptyAction={
        canCreate ? (
          <Link href="/documents/new" className="btn btn-primary btn-sm">
            <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
            <span>{t('upload')}</span>
          </Link>
        ) : undefined
      }
    >
      {data && (
        <>
          {/* Calm orientation: what still needs attention, in plain Hebrew. */}
          <BoardOrientation
            unmet={data.unmetParties}
            hasAnyRequirement={data.hasAnyRequirement}
            tParty={tParty}
          />
          <ul
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            aria-label={t('views.party')}
          >
            {ranked.map((c) => (
              <li key={c.party}>
                <PartyCard
                  completeness={c}
                  canCreate={canCreate}
                  onOpen={c.total > 0 ? () => setActiveParty(c.party) : undefined}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </DataState>
  );
}

/** Plain-Hebrew orientation — names the first two parties whose required set is
 *  still unmet, "+N" the rest, "all in order" when none. User-voiced (the user's
 *  situation, never "the system did X"). Suppressed when the board has no
 *  requirement anywhere (nothing to orient against). */
function BoardOrientation({
  unmet,
  hasAnyRequirement,
  tParty,
}: {
  unmet: DocumentParty[];
  hasAnyRequirement: boolean;
  tParty: ReturnType<typeof useTranslations>;
}) {
  const t = useTranslations('documents');
  if (!hasAnyRequirement) return null;

  let body: string;
  if (unmet.length === 0) {
    body = t('board.orientation.allFilled');
  } else {
    const names = unmet.map((p) => tParty(p));
    let partiesText: string;
    if (names.length === 1) {
      partiesText = names[0]!;
    } else if (names.length === 2) {
      partiesText = t('board.orientation.twoParties', { first: names[0]!, second: names[1]! });
    } else {
      partiesText = t('board.orientation.manyParties', {
        first: names[0]!,
        count: names.length - 1,
      });
    }
    body = t('board.orientation.someUnmet', { parties: partiesText });
  }
  return (
    <p className="mb-3 text-sm text-text-muted" role="status">
      {body}
    </p>
  );
}

/**
 * One PARTY card. Calm by default; the SERVER `total` is the headline count
 * (truthful at scale), the gist reads completeness or the latest doc, and the
 * completeness badge is the ONLY color signal (success when met, warning when
 * unmet). A ghost (zero docs) card is muted; when it has an unmet requirement it
 * surfaces the GAP ("חסר: …") + a one-click "העלה {missing}" deep-link so the
 * missing work is an ACTION, not a flat label.
 */
function PartyCard({
  completeness,
  canCreate,
  onOpen,
}: {
  completeness: PartyCompleteness;
  canCreate: boolean;
  onOpen?: () => void;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const locale = useDisplayLocale();
  const { party, total, latestType, latestCreatedAt } = completeness;
  const Icon = PARTY_META[party].icon;
  const name = tParty(party);
  const labels = locale === 'he' ? DOCUMENT_TYPE_LABELS_HE : DOCUMENT_TYPE_LABELS_EN;

  const hasRequirement = completeness.hasRequirement;
  const isComplete = completeness.isComplete;
  const missingLabels = completeness.missingTypes.map((m) => labels[m.type] ?? m.type);
  // The first missing required type drives the one-click upload deep-link.
  const firstMissingType = completeness.missingTypes[0]?.type ?? null;

  const latestLabel = latestType ? (labels[latestType] ?? latestType) : null;

  // TWO DISTINCT FACTS (the "0 מתוך X" fix) — these answer DIFFERENT questions
  // and must NEVER be divided into one another:
  //   1. docsFiled — how many documents are filed under this party ("{total}
  //      מסמכים"), the headline. With latest-type context when the party is calm.
  //   2. coreGauge — the CORE required-slot completeness ("מסמכי-ליבה
  //      {received}/{required}"), a SEPARATE clause shown only when the party has a
  //      requirement. A party with docs but no required-type doc reads
  //      "37 מסמכים · מסמכי-ליבה 0/3", NEVER "0 מתוך 37".
  const isGhost = total === 0;

  // Fact 1 — docs filed (always leads). Ghost → "טרם התקבלו מסמכים"; otherwise
  // "{total} מסמכים", enriched with the latest type only when there's nothing more
  // urgent to say (no unmet core requirement).
  const docsFiledLine = (() => {
    if (isGhost) return t('board.ghost');
    if (latestLabel && !(hasRequirement && !isComplete)) {
      return t('board.gist.latestType', { count: total, type: latestLabel });
    }
    return t('board.docsFiled', { count: total });
  })();

  // Fact 2 — the CORE required-slot gauge, a distinct clause (only when this party
  // carries a requirement). Never the headline; never a denominator of `total`.
  const coreLine = hasRequirement
    ? isComplete
      ? t('board.core.complete', {
          received: completeness.received,
          required: completeness.required,
        })
      : t('board.core.missing', {
          received: completeness.received,
          required: completeness.required,
          types: missingLabels.join(' · '),
        })
    : null;
  // The missing-type deep-link, shown on an incomplete/ghost card (gated on
  // create). Phase 2d honors `?type=&party=` to pre-fill the upload form.
  const uploadGap =
    canCreate && hasRequirement && !isComplete && firstMissingType ? (
      <Link
        href={`/documents/new?type=${encodeURIComponent(firstMissingType)}&party=${party}`}
        onClick={(e) => e.stopPropagation()}
        className="btn btn-secondary btn-sm shrink-0"
        aria-label={t('board.uploadMissingAria', {
          type: labels[firstMissingType] ?? firstMissingType,
          party: name,
        })}
      >
        <Upload className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          {t('board.uploadMissing', { type: labels[firstMissingType] ?? firstMissingType })}
        </span>
      </Link>
    ) : null;

  const inner = (
    <>
      <PartyIconTile Icon={Icon} muted={isGhost} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={`truncate text-sm font-semibold ${isGhost ? 'text-text-muted' : 'text-foreground'}`}
          >
            {name}
          </span>
          {total > 0 && (
            <span className="shrink-0 rounded-full bg-surface-subtle px-1.5 text-xs tabular-nums text-text-muted">
              {total}
            </span>
          )}
        </div>
        {/* Fact 1 — docs filed (the headline line). */}
        <span className="truncate text-xs text-text-soft">{docsFiledLine}</span>
        {/* Fact 2 — the CORE required-slot gauge, on its own line (never merged
            into the docs-filed count). Tinted by met/unmet, but it is a distinct
            fact, not "{received} מתוך {total}". */}
        {coreLine && (
          <span
            className="truncate text-[11px]"
            style={{
              color: isComplete ? 'var(--success-600)' : 'var(--warning-700, var(--text-muted))',
            }}
          >
            {coreLine}
          </span>
        )}
        {latestCreatedAt && total > 0 && (
          <span className="truncate text-[11px] text-text-soft">
            {t('board.gist.latestWhen', { when: formatRelative(latestCreatedAt, locale) })}
          </span>
        )}
      </div>
      {hasRequirement ? (
        <CompletenessBadge
          received={completeness.received}
          required={completeness.required}
          unmet={!isComplete}
        />
      ) : (
        total > 0 && (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'var(--success-50)' }}
            title={t('board.complete')}
            aria-hidden="true"
          >
            <Check className="h-3.5 w-3.5" style={{ color: 'var(--success-600)' }} />
          </span>
        )
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('board.open', { party: name })}
          className="card flex w-full items-center gap-3 px-4 py-3.5 text-start transition-colors hover:bg-surface-subtle focus:outline-none focus-visible:bg-surface-subtle"
          style={{ cursor: 'pointer' }}
        >
          {inner}
        </button>
      ) : (
        <div
          className="card flex items-center gap-3 px-4 py-3.5"
          style={{ opacity: isGhost ? 0.75 : 1 }}
          aria-disabled={isGhost ? 'true' : undefined}
        >
          {inner}
        </div>
      )}
      {uploadGap && <div className="ps-1">{uploadGap}</div>}
    </div>
  );
}

/** The per-party completeness pill — a quiet "X/Y" count. Tint is the ONLY
 *  color signal (success met, warning unmet). Counts only, no PII. */
function CompletenessBadge({
  received,
  required,
  unmet,
}: {
  received: number;
  required: number;
  unmet: boolean;
}) {
  const t = useTranslations('documents');
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
      style={{
        background: unmet ? 'var(--warning-50, var(--bg-subtle))' : 'var(--success-50)',
        color: unmet ? 'var(--warning-700, var(--text-muted))' : 'var(--success-600)',
      }}
      title={t('board.completeness', { received, required })}
      aria-label={t('board.completeness', { received, required })}
    >
      {!unmet && <Check className="h-3 w-3" aria-hidden="true" />}
      <span aria-hidden="true">
        {received}/{required}
      </span>
    </span>
  );
}

/** The small rounded icon tile inside a party card. */
function PartyIconTile({
  Icon,
  muted = false,
}: {
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  muted?: boolean;
}) {
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
      style={{
        background: muted ? 'var(--bg-subtle)' : 'var(--navy-50)',
        color: muted ? 'var(--text-soft)' : 'var(--navy-700)',
      }}
      aria-hidden="true"
    >
      <Icon className="h-5 w-5" aria-hidden={true} />
    </span>
  );
}

/**
 * Server-paginated party zoom-in. The card's headline `total` (from the server
 * summary) is the AUTHORITATIVE count; the rows materialize by paging the
 * documents list and accumulating ONLY this party's docs (`providerPartyForDoc
 * Type`), with a "load more" that fetches the next keyset page until the board
 * is exhausted — never a single truncated bucket. Each row carries quick
 * download + archive.
 */
function PartyZoomIn({
  completeness,
  archived,
  canCreate,
  onBack,
}: {
  completeness: PartyCompleteness;
  archived: boolean;
  canCreate: boolean;
  onBack: () => void;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const name = tParty(completeness.party);

  const acc = usePartyDocuments(completeness.party, archived);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted"
          style={{ cursor: 'pointer' }}
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          {t('board.back')}
        </button>
        <span className="text-sm font-semibold text-foreground">{name}</span>
        {/* Server-truthful headline count — NEVER the loaded page size. */}
        <span className="text-xs text-text-muted">
          {t('board.gist.count', { count: completeness.total })}
        </span>
      </div>

      <DataState
        isLoading={acc.isLoading}
        isError={acc.isError}
        onRetry={acc.retry}
        skeleton="list"
        isEmpty={acc.isDone && acc.items.length === 0}
        emptyTitle={t('board.zoomEmpty')}
      >
        <ul className="flex flex-col gap-1.5">
          {acc.items.map((d) => (
            <li key={d.id}>
              <DocumentRow doc={d} canCreate={canCreate} onArchived={acc.onArchived} />
            </li>
          ))}
        </ul>
        <LoadMore
          canLoadMore={acc.canLoadMore}
          isFetching={acc.isFetchingMore}
          onClick={acc.loadMore}
        />
      </DataState>
    </div>
  );
}

// ── Tier 2 — the PROJECT board ──────────────────────────────────────────────

/** The project board — every in-scope project as a zoom-in tile (server order),
 *  drilling into that project's own documents (server-paginated). The multi-
 *  project manager's mental model the party axis alone can't express. */
function ProjectBoard({ archived, canCreate }: { archived: boolean; canCreate: boolean }) {
  const t = useTranslations('documents');
  const { data, isLoading, isError, refetch } = useProjectList({ limit: 100 });
  const [activeProject, setActiveProject] = useState<ProjectViewModel | null>(null);
  useEffect(() => setActiveProject(null), [archived]);

  if (activeProject) {
    return (
      <ProjectZoomIn
        project={activeProject}
        archived={archived}
        canCreate={canCreate}
        onBack={() => setActiveProject(null)}
      />
    );
  }

  const projects = data?.items ?? [];

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      error={undefined}
      isEmpty={projects.length === 0}
      onRetry={() => void refetch()}
      skeleton="list"
      emptyTitle={t('project.empty')}
    >
      <ul
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        aria-label={t('views.project')}
      >
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setActiveProject(p)}
              aria-label={t('project.open', { name: p.name })}
              className="card flex w-full items-center gap-3 px-4 py-3.5 text-start transition-colors hover:bg-surface-subtle focus:outline-none focus-visible:bg-surface-subtle"
              style={{ cursor: 'pointer' }}
            >
              <PartyIconTile Icon={Building2} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-foreground">
                  <NameDisplay name={p.name} />
                </span>
                <span className="truncate text-xs text-text-soft">{p.typeLabel}</span>
              </div>
              <StatusBadge intent={p.intent} className="shrink-0">
                {p.statusLabel}
              </StatusBadge>
            </button>
          </li>
        ))}
      </ul>
    </DataState>
  );
}

/** Server-paginated project zoom-in — the project's own documents via the
 *  list endpoint's `projectId` filter (no client truncation), each row with
 *  quick download + archive. */
function ProjectZoomIn({
  project,
  archived,
  canCreate,
  onBack,
}: {
  project: ProjectViewModel;
  archived: boolean;
  canCreate: boolean;
  onBack: () => void;
}) {
  const t = useTranslations('documents');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  useEffect(() => setCursor(undefined), [archived]);
  const { data, isLoading, isError, refetch } = useDocumentList({
    limit: PAGE_LIMIT,
    cursor,
    projectId: project.id,
    archived,
  });
  const items = data?.items ?? [];
  const page = data?.page;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted"
          style={{ cursor: 'pointer' }}
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          {t('project.back')}
        </button>
        <span className="text-sm font-semibold text-foreground">
          <NameDisplay name={project.name} />
        </span>
      </div>

      <DataState
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        skeleton="list"
        isEmpty={items.length === 0}
        emptyTitle={t('project.zoomEmpty')}
        emptyAction={
          canCreate ? (
            <Link
              href={`/documents/new?projectId=${project.id}`}
              className="btn btn-primary btn-sm"
            >
              <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
              <span>{t('upload')}</span>
            </Link>
          ) : undefined
        }
      >
        <ul className="flex flex-col gap-1.5">
          {items.map((d) => (
            <li key={d.id}>
              <DocumentRow doc={d} canCreate={canCreate} onArchived={() => void refetch()} />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          {page?.has_more && page.cursor && (
            <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor ?? undefined)}>
              {t('loadMore')}
            </Button>
          )}
          {cursor && (
            <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
              {t('resetPage')}
            </Button>
          )}
        </div>
      </DataState>
    </div>
  );
}

// ── "כל המסמכים" — flat forensic list ───────────────────────────────────────

/** The flat forensic list — every document, server-paginated, legible rows. The
 *  "find one document" path; preserved as the secondary view. */
function FlatDocumentList({ archived, canCreate }: { archived: boolean; canCreate: boolean }) {
  const t = useTranslations('documents');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  useEffect(() => setCursor(undefined), [archived]);
  const { data, isLoading, isError, refetch } = useDocumentList({
    limit: PAGE_LIMIT,
    cursor,
    archived,
  });
  const items = data?.items ?? [];
  const page = data?.page;

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      onRetry={() => void refetch()}
      skeleton="list"
      isEmpty={items.length === 0}
      emptyTitle={archived ? t('archivedEmpty') : t('empty')}
      emptyAction={
        canCreate && !archived ? (
          <Link href="/documents/new" className="btn btn-primary btn-sm">
            <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
            <span>{t('upload')}</span>
          </Link>
        ) : undefined
      }
    >
      <ul className="flex flex-col gap-1.5" aria-label={t('views.all')}>
        {items.map((d) => (
          <li key={d.id}>
            <DocumentRow doc={d} canCreate={canCreate} onArchived={() => void refetch()} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {page?.has_more && page.cursor && (
          <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor ?? undefined)}>
            {t('loadMore')}
          </Button>
        )}
        {cursor && (
          <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            {t('resetPage')}
          </Button>
        )}
      </div>
    </DataState>
  );
}

// ── Server search results ───────────────────────────────────────────────────

/** Server-side search results (across the whole board, debounced). Flat legible
 *  rows; replaces the active view while the search box is non-empty. */
function SearchResults({
  query,
  archived,
  canCreate,
}: {
  query: string;
  archived: boolean;
  canCreate: boolean;
}) {
  const t = useTranslations('documents');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // A changed query / archived flip resets pagination to the first page.
  useEffect(() => setCursor(undefined), [query, archived]);
  const { data, isLoading, isError, refetch } = useDocumentSearch({
    q: query,
    limit: PAGE_LIMIT,
    cursor,
    archived,
  });
  const items = data?.items ?? [];
  const page = data?.page;

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      onRetry={() => void refetch()}
      skeleton="list"
      isEmpty={items.length === 0}
      emptyTitle={t('noResults')}
    >
      <ul className="flex flex-col gap-1.5" aria-label={t('searchPlaceholder')}>
        {items.map((d) => (
          <li key={d.id}>
            <DocumentRow doc={d} canCreate={canCreate} onArchived={() => void refetch()} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {page?.has_more && page.cursor && (
          <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor ?? undefined)}>
            {t('loadMore')}
          </Button>
        )}
        {cursor && (
          <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
            {t('resetPage')}
          </Button>
        )}
      </div>
    </DataState>
  );
}

// ── A single legible document row + its quick actions ───────────────────────

/**
 * One document row — legible at a glance: the icon + name, the type + project
 * (+ apartment when present) always visible, a SENSITIVE/scan marker when
 * relevant, a de-emphasized size/date, and quick actions (download + archive).
 * The whole row links to the detail page; the actions are buttons inside it.
 */
function DocumentRow({
  doc,
  canCreate,
  onArchived,
}: {
  doc: DocumentViewModel;
  canCreate: boolean;
  onArchived: () => void;
}) {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const canDownload = useHasPermission('documents.download');
  const canArchive = useHasPermission('documents.archive');

  // The row card is a plain container; the NAME + metadata is the navigation
  // <Link>, and the quick-action buttons are SIBLINGS (never nested inside the
  // anchor — that would be invalid HTML / a hydration warning).
  return (
    <div className="card flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-surface-subtle">
      <FileText className="h-4 w-4 shrink-0 text-navy-700" aria-hidden="true" />
      <Link
        href={`/documents/${doc.id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 focus:outline-none focus-visible:underline"
      >
        <span className="truncate text-sm text-foreground">
          <NameDisplay name={doc.name} />
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-soft">
          <span>{doc.typeLabel}</span>
          {doc.projectName && (
            <span>
              · <NameDisplay name={doc.projectName} />
            </span>
          )}
          {doc.apartmentName && <span>· {t('row.apartment', { number: doc.apartmentName })}</span>}
          {doc.isSensitive && (
            <span className="badge badge-warning shrink-0">{t('row.sensitive')}</span>
          )}
          {!doc.isScanClean && (
            <span className="badge badge-neutral shrink-0">{doc.scanStatusLabel}</span>
          )}
        </span>
      </Link>
      <span className="hidden shrink-0 text-[11px] text-text-soft sm:inline" dir="ltr">
        {doc.sizeLabel} · {doc.createdRelative}
      </span>
      {doc.isArchived ? (
        <span className="badge badge-neutral shrink-0">
          <span className="badge-dot" aria-hidden="true" />
          <span>{tp('archived')}</span>
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {canDownload && doc.isScanClean && <DownloadButton doc={doc} />}
          {canArchive && canCreate && <ArchiveButton doc={doc} onArchived={onArchived} />}
        </div>
      )}
    </div>
  );
}

/** Quick download — reuses `useDownloadDocument` (dual-mode) + the step-up
 *  unlock for sensitive docs + the same safe new-tab open as the detail page,
 *  with a popup-blocked toast. The button stops the row's <Link> navigation. */
function DownloadButton({ doc }: { doc: DocumentViewModel }) {
  const t = useTranslations('documents');
  const toast = useToast();
  const download = useDownloadDocument();
  const stepUp = useStepUpUnlock();

  async function onDownload() {
    try {
      const result = await stepUp.withStepUp(() =>
        download.mutateAsync({ id: doc.id, disposition: 'attachment' }),
      );
      if (result.kind === 'presign') {
        if (!/^https:\/\//i.test(result.url)) {
          toast.show({ message: t('downloadFailed'), variant: 'assertive' });
          return;
        }
        const win = window.open(result.url, '_blank', 'noopener,noreferrer');
        if (!win) toast.show({ message: t('popupBlocked'), variant: 'assertive' });
        return;
      }
      // Bytes leg — local object URL (sensitive decrypt-streamed doc).
      const objectUrl = URL.createObjectURL(result.blob);
      const win = window.open(objectUrl, '_blank', 'noopener,noreferrer');
      if (!win) toast.show({ message: t('popupBlocked'), variant: 'assertive' });
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (e) {
      if (isStepUpCancelled(e)) return;
      toast.show({ message: t('downloadFailed'), variant: 'assertive' });
    }
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={download.isPending}
      aria-busy={download.isPending}
      aria-label={t('row.downloadAria', { name: doc.name })}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (download.isPending) return;
        void onDownload();
      }}
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{t('download')}</span>
    </button>
  );
}

/** Quick archive — confirm, then `useArchiveDocument`; refreshes the surface
 *  on success and shows a calm toast. Stops the row's <Link> navigation. */
function ArchiveButton({ doc, onArchived }: { doc: DocumentViewModel; onArchived: () => void }) {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const toast = useToast();
  const archive = useArchiveDocument();
  const { confirm, dialog } = useConfirm();

  async function onArchive() {
    if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
    try {
      await archive.mutateAsync(doc.id);
      toast.show({ message: t('archiveDone') });
      onArchived();
    } catch {
      toast.show({ message: t('archiveFailed'), variant: 'assertive' });
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={archive.isPending}
        aria-busy={archive.isPending}
        aria-label={t('row.archiveAria', { name: doc.name })}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (archive.isPending) return;
          void onArchive();
        }}
      >
        <span className="text-xs">{tp('archive')}</span>
      </button>
      {dialog}
    </>
  );
}

/** A shared "load more" footer for the accumulating zoom-in. */
function LoadMore({
  canLoadMore,
  isFetching,
  onClick,
}: {
  canLoadMore: boolean;
  isFetching: boolean;
  onClick: () => void;
}) {
  const t = useTranslations('documents');
  if (!canLoadMore) return null;
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={isFetching}>
      {isFetching ? t('loadingMore') : t('loadMore')}
    </Button>
  );
}

// ── Party-document accumulator (server-paginated, party-bucketed) ───────────

/**
 * Accumulate ONE party's documents by paging the documents LIST endpoint and
 * keeping only the rows that roll up to this party (`providerPartyForDocType`).
 * The party board's headline count comes from the SERVER summary (never this);
 * this only materializes the rows on demand, paging until the board is exhausted
 * (progressive disclosure). Each page is a real keyset page, so this never
 * silently truncates — "load more" fetches the next page and appends.
 *
 * The documents list endpoint has no server-side `party` filter (only `/search`
 * does, and that requires a name query), so the party narrowing is applied to
 * each fetched page here. The count shown to the user is always the server
 * `total`, so the count is truthful regardless of how many pages are loaded.
 */
function usePartyDocuments(party: DocumentParty, archived: boolean) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [acc, setAcc] = useState<DocumentViewModel[]>([]);
  const [exhausted, setExhausted] = useState(false);

  // Reset the accumulator when the party or archived scope changes.
  useEffect(() => {
    setCursor(undefined);
    setAcc([]);
    setExhausted(false);
  }, [party, archived]);

  const { data, isLoading, isError, isFetching, refetch } = useDocumentList({
    limit: PAGE_LIMIT,
    cursor,
    archived,
  });

  // Fold each fetched page into the accumulator (dedup by id so a refetch of the
  // same cursor never double-appends), keeping only this party's docs.
  useEffect(() => {
    if (!data) return;
    const partyDocs = data.items.filter((d) => providerPartyForDocType(d.type) === party);
    setAcc((prev) => {
      const seen = new Set(prev.map((d) => d.id));
      const next = [...prev];
      for (const d of partyDocs) if (!seen.has(d.id)) next.push(d);
      return next;
    });
    if (!data.page.has_more) setExhausted(true);
  }, [data, party]);

  const canLoadMore = !exhausted && Boolean(data?.page.has_more);
  // First-load only when nothing has accumulated yet (later pages keep the list).
  const isLoadingFirst = isLoading && acc.length === 0 && cursor === undefined;
  const isFetchingMore = isFetching && cursor !== undefined;

  return {
    items: acc,
    isLoading: isLoadingFirst,
    isError,
    isFetchingMore,
    canLoadMore,
    isDone: exhausted,
    loadMore: () => {
      if (data?.page.has_more && data.page.cursor) setCursor(data.page.cursor);
    },
    retry: () => void refetch(),
    onArchived: () => {
      // Drop the archived doc from the accumulator immediately; the underlying
      // list query is also invalidated by the mutation so the next page is fresh.
      void refetch();
    },
  };
}
