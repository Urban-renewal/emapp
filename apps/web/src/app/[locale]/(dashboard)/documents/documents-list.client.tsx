'use client';

import type { DocumentParty, PartyCompleteness } from '@emapp/shared-types';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
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
import { ShareActivityPanel } from '@/app/[locale]/(dashboard)/_components/share-activity-panel';
import { useShareSheet } from '@/app/[locale]/(dashboard)/_components/share-sheet';
import { isStepUpCancelled, useStepUpUnlock } from '@/components/step-up-unlock';
import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { ThresholdSliver } from '@/components/ui/threshold-progress';
import {
  useArchiveDocument,
  useBoardCompleteness,
  useDocumentList,
  useDocumentsBoard,
  useDocumentSearch,
  useDownloadDocument,
} from '@/hooks/use-documents';
import { useHasPermission } from '@/hooks/use-permissions';
import { useDocumentChecklist } from '@/hooks/use-projects';
import { DOCUMENT_PARTIES, providerPartyForDocType } from '@/lib/document-party';
import { formatRelative } from '@/lib/format';
import { useDisplayLocale } from '@/lib/locale';
import type { DocumentViewModel } from '@/models/document.vm';
import type {
  DocumentFleetTileViewModel,
  DocumentProjectAttentionViewModel,
  DocumentsBoardViewModel,
} from '@/models/documents-board.vm';

/**
 * Documents page — the org-customer SITUATION-PICTURE cockpit
 * (DOCUMENTS-PROCESS-DESIGN S2). REPLACES the flat-wall surfaces (9 party cards
 * over a flat tile grid; a flat "כל המסמכים" scroll; a flat search) with a
 * board-first cockpit that REUSES the canonical situation-picture pattern (the
 * signatures board primitives + `<ThresholdSliver>` + `<DataState>`), composed —
 * never re-coded:
 *
 *   • Tier 0 — the pulse sentence: "{behind} מתוך {total} פרויקטים חסרים
 *     מסמכי-ליבה" (from `useDocumentsBoard`, the board-completeness wire's S2
 *     project-attention axis).
 *   • Tier 1 — "מצב הפרויקטים" (DEFAULT): ranked project-attention cards
 *     (worst-first), each naming the missing party/types + a one-click "העלה
 *     {type}" deep-link to /documents/new?type=&party=&projectId=.
 *   • Tier 2 — the fleet: every behind project as a compact completeness tile
 *     (a document-completeness `ThresholdSliver` + "X/Y ליבה"), capped + a calm
 *     "+N השלימו" tail for the met projects.
 *   • "כל המסמכים" — a GROUPED (project→party, collapsible, attention-first) +
 *     server-FACETED shell (party/scope + the search box), NOT a flat scroll.
 *     The flat `DocumentRow` stays the LEAF inside a group.
 *   • "לפי גורם" — the party-binder board, kept as a SECONDARY axis.
 *
 * The cockpit cards + fleet tiles drill into an in-page project zoom-in that
 * LEADS with the required-vs-received core-document checklist (the built
 * `GET /projects/:id/document-checklist`, previously unsurfaced) — missing slots
 * are one-click uploads — THEN the project's own docs.
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

/** The cockpit views. `cockpit` (default) = the project-attention situation-
 *  picture; `party` = the binder board (secondary axis); `all` = the grouped +
 *  faceted "all documents" shell (NOT a flat scroll). */
type DocView = 'cockpit' | 'party' | 'all';
const DOC_VIEWS: DocView[] = ['cockpit', 'party', 'all'];

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 25;

/** The minimal project handle the in-page zoom-in needs (id + display name). */
interface ProjectRef {
  id: string;
  name: string;
}

export function DocumentsListClient() {
  const t = useTranslations('documents');

  const [view, setView] = useState<DocView>('cockpit');
  // Active (default) vs archived view — soft-archived docs are otherwise
  // invisible in the cockpit. The toggle applies to every view + search.
  const [archived, setArchived] = useState(false);
  // The raw search box value + its debounced counterpart (the actual query
  // that hits the server). A non-empty debounced query takes over the surface
  // (it drops into the grouped+faceted "all" shell, never a flat list).
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

      {/* A non-empty search takes over the surface with the grouped+faceted shell
          (server search results, grouped by project→party — NOT a flat list). */}
      {searching ? (
        <GroupedAllDocuments archived={archived} canCreate={canCreate} searchQuery={query} />
      ) : (
        <>
          {/* View toggle: מצב הפרויקטים (default) | לפי גורם | כל המסמכים. */}
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

          {view === 'cockpit' && <CockpitView archived={archived} canCreate={canCreate} />}
          {view === 'party' && <PartyBoard archived={archived} canCreate={canCreate} />}
          {view === 'all' && <GroupedAllDocuments archived={archived} canCreate={canCreate} />}
        </>
      )}
    </div>
  );
}

// ── Tier 0-2 — the project-attention COCKPIT (the default) ──────────────────

/**
 * The cockpit — the project-attention situation-picture (S2 gap #1). Pulse
 * sentence → ranked attention cards (worst-first, each a one-click upload) →
 * fleet tiles (every behind project as a completeness tile + a calm met tail).
 * Reads the board-completeness wire's S2 axis via `useDocumentsBoard`; routes
 * every non-happy state through `<DataState>`. Cards/tiles drill into the in-
 * page project zoom-in (which LEADS with the core-document checklist).
 */
function CockpitView({ archived, canCreate }: { archived: boolean; canCreate: boolean }) {
  const t = useTranslations('documents');
  const { data: vm, isLoading, isError, refetch } = useDocumentsBoard();
  const [activeProject, setActiveProject] = useState<ProjectRef | null>(null);
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

  const openProject = (p: { projectId: string; projectName: string }) =>
    setActiveProject({ id: p.projectId, name: p.projectName });

  return (
    <div className="flex flex-col gap-5">
      {/* Tier 0 — the pulse sentence. */}
      <CockpitPulse vm={vm} />

      {/* Tier 1 — ranked attention cards. */}
      <DataState
        isLoading={isLoading}
        isError={isError}
        error={undefined}
        isEmpty={Boolean(vm && vm.attention.length === 0)}
        onRetry={() => void refetch()}
        skeleton="list"
        emptyTitle={
          vm && !vm.hasAnyRequirement ? t('cockpit.noProjectsTitle') : t('cockpit.allClearTitle')
        }
        emptyHint={vm && vm.hasAnyRequirement ? t('cockpit.allClearHint') : undefined}
        emptyAction={
          vm && vm.isAllClear ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Check className="h-4 w-4 text-brand" aria-hidden="true" />
              {t('cockpit.allClearTitle')}
            </span>
          ) : undefined
        }
      >
        {vm && vm.attention.length > 0 && (
          <section aria-label={t('cockpit.heading')} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">{t('cockpit.heading')}</h2>
            <ul className="flex flex-col gap-3">
              {vm.attention.map((p) => (
                <li key={p.projectId}>
                  <ProjectAttentionCard
                    project={p}
                    canCreate={canCreate}
                    onOpen={() => openProject(p)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </DataState>

      {/* Tier 2 — the fleet (only when there are behind projects to show). */}
      {vm && vm.attention.length > 0 && <CockpitFleet vm={vm} onOpen={openProject} />}
    </div>
  );
}

/** Tier 0 — the ONE calm pulse sentence (projects-behind summary). */
function CockpitPulse({ vm }: { vm: DocumentsBoardViewModel | undefined }) {
  const t = useTranslations('documents');
  const body = (() => {
    if (!vm) return t('cockpit.pulse.loading');
    if (!vm.hasAnyRequirement) return t('cockpit.pulse.noRequirement');
    if (vm.projectsBehindCount === 0) {
      return t('cockpit.pulse.allClear', { total: vm.projectsWithRequirement });
    }
    return vm.projectsBehindCapped
      ? t('cockpit.pulse.behindCapped', {
          behind: vm.projectsBehindCount,
          total: vm.projectsWithRequirement,
        })
      : t('cockpit.pulse.behind', {
          behind: vm.projectsBehindCount,
          total: vm.projectsWithRequirement,
        });
  })();
  return (
    <p className="text-sm text-text-muted" role="status">
      {body}
    </p>
  );
}

/**
 * One ranked project-attention card. Names the missing party/types in plain
 * Hebrew and carries a one-click "העלה {type}" deep-link to the upload form
 * pre-scoped to ?type=&party=&projectId=. The completeness sliver gives the
 * at-a-glance core progress. Presentational — every derivation is in the adapter.
 */
function ProjectAttentionCard({
  project,
  canCreate,
  onOpen,
}: {
  project: DocumentProjectAttentionViewModel;
  canCreate: boolean;
  onOpen: () => void;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const first = project.firstMissing;

  const whyLine = (() => {
    if (!first) return null;
    const partyLabel = tParty(first.party);
    if (project.missing.length === 1) {
      return t('cockpit.card.missingOne', { type: first.typeLabel, party: partyLabel });
    }
    return t('cockpit.card.missingMany', {
      first: first.typeLabel,
      count: project.missing.length - 1,
      party: partyLabel,
    });
  })();

  return (
    <article className="card card-pad flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <StatusBadge intent="warning">
              {t('cockpit.card.core', {
                received: project.coreReceived,
                required: project.coreRequired,
              })}
            </StatusBadge>
            <span className="truncate text-sm font-medium text-foreground">
              <NameDisplay name={project.projectName} />
            </span>
          </div>
          {whyLine && <p className="text-sm text-text-muted">{whyLine}</p>}
          <ThresholdSliver consentedPct={project.completionPct} metThreshold={false} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="btn btn-secondary btn-sm"
            aria-label={t('cockpit.card.openAria', { name: project.projectName })}
          >
            <span>{t('cockpit.card.open', { name: project.projectName })}</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {canCreate && first && (
            <Link
              href={`/documents/new?type=${encodeURIComponent(first.type)}&party=${first.party}&projectId=${project.projectId}`}
              className="btn btn-primary btn-sm"
              aria-label={t('cockpit.card.uploadAria', {
                type: first.typeLabel,
                name: project.projectName,
              })}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('board.uploadMissing', { type: first.typeLabel })}</span>
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

/** Tier 2 — the fleet: every BEHIND project as a compact completeness tile,
 *  capped, with a calm "+N met" tail for the projects that finished their core
 *  set (those are summarised, not rendered as tiles — keeps the surface calm). */
function CockpitFleet({
  vm,
  onOpen,
}: {
  vm: DocumentsBoardViewModel;
  onOpen: (p: { projectId: string; projectName: string }) => void;
}) {
  const t = useTranslations('documents');
  const tiles: DocumentFleetTileViewModel[] = vm.attention.map((p) => ({
    projectId: p.projectId,
    projectName: p.projectName,
    coreReceived: p.coreReceived,
    coreRequired: p.coreRequired,
    completionPct: p.completionPct,
    isComplete: p.coreReceived >= p.coreRequired,
  }));
  // The met-projects tail = (projects with a requirement) − (behind, possibly capped).
  const metCount = Math.max(0, vm.projectsWithRequirement - vm.projectsBehindCount);

  return (
    <section aria-labelledby="documents-cockpit-fleet" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="documents-cockpit-fleet" className="text-sm font-semibold text-foreground">
          {t('cockpit.fleet.heading', { count: vm.projectsWithRequirement })}
        </h2>
        {vm.projectsBehindCapped && (
          <Link
            href="/projects"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-foreground"
          >
            <span>{t('cockpit.fleet.showAll')}</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.projectId}>
            <FleetCompletenessTile tile={tile} onOpen={() => onOpen(tile)} />
          </li>
        ))}
      </ul>

      {/* Calm tail: the met projects + a "+N more behind" note when capped. */}
      <div className="flex flex-col gap-0.5">
        {metCount > 0 && (
          <p className="text-xs text-text-muted" role="status">
            {t('cockpit.fleet.metTail', { count: metCount })}
          </p>
        )}
        {vm.projectsBehindCapped && (
          <p className="text-xs text-text-muted" role="status">
            {t('cockpit.fleet.moreBehind', { count: '12+' })}
          </p>
        )}
      </div>
    </section>
  );
}

/** One compact project completeness tile — opens the in-page project zoom-in,
 *  carrying its core-completeness sliver + "X/Y ליבה" text. Presentational. */
function FleetCompletenessTile({
  tile,
  onOpen,
}: {
  tile: DocumentFleetTileViewModel;
  onOpen: () => void;
}) {
  const t = useTranslations('documents');
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card card-pad flex w-full flex-col gap-2 text-start transition-colors hover:bg-surface-subtle focus:outline-none focus-visible:bg-surface-subtle"
      style={{ cursor: 'pointer' }}
      aria-label={t('cockpit.card.openAria', { name: tile.projectName })}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          <NameDisplay name={tile.projectName} />
        </span>
        {tile.isComplete ? (
          <StatusBadge intent="success" className="shrink-0">
            {t('cockpit.fleet.complete')}
          </StatusBadge>
        ) : (
          <StatusBadge intent="warning" className="shrink-0">
            {t('cockpit.card.core', { received: tile.coreReceived, required: tile.coreRequired })}
          </StatusBadge>
        )}
      </div>
      <ThresholdSliver consentedPct={tile.completionPct} metThreshold={tile.isComplete} />
    </button>
  );
}

// ── Secondary axis — the PARTY board ────────────────────────────────────────

/**
 * The party board — cards from the SERVER board-summary, ranked attention-first.
 * Kept as the SECONDARY "לפי גורם" axis (the project-attention cockpit is the
 * default). Each card's headline count is the whole-board `total` (truthful at
 * scale); an incomplete/ghost party surfaces a one-click "העלה {missing}".
 */
function PartyBoard({ archived, canCreate }: { archived: boolean; canCreate: boolean }) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const { data, isLoading, isError, refetch } = useBoardCompleteness();
  const [activeParty, setActiveParty] = useState<DocumentParty | null>(null);
  useEffect(() => setActiveParty(null), [archived]);

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
 *  still unmet, "+N" the rest, "all in order" when none. User-voiced. */
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
 * (truthful at scale); an incomplete/ghost party surfaces the GAP ("חסר: …") +
 * a one-click "העלה {missing}" deep-link.
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
  const firstMissingType = completeness.missingTypes[0]?.type ?? null;

  const latestLabel = latestType ? (labels[latestType] ?? latestType) : null;

  const isGhost = total === 0;

  const docsFiledLine = (() => {
    if (isGhost) return t('board.ghost');
    if (latestLabel && !(hasRequirement && !isComplete)) {
      return t('board.gist.latestType', { count: total, type: latestLabel });
    }
    return t('board.docsFiled', { count: total });
  })();

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
        <span className="truncate text-xs text-text-soft">{docsFiledLine}</span>
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
 *  color signal. Counts only, no PII. */
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
 * documents list and accumulating ONLY this party's docs, with a "load more"
 * until the board is exhausted. Each row carries quick download + archive.
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

// ── "כל המסמכים" — GROUPED (project→party) + server-FACETED shell ───────────

type ScopeFacet = 'project' | 'apartment' | 'org';

/**
 * The "all documents" surface (S2 gap #2) — NOT a flat scroll. A facet rail
 * (party / scope) + (when searching) the server search; the docs come back
 * server-paginated and are GROUPED by project → party (collapsible, counts,
 * attention-first), with an attention band on top (pending-scan / ghost
 * uploads). The flat `DocumentRow` is the LEAF inside a group, so the CONTAINER
 * stops being flat. The search path applies the facets server-side (party/scope);
 * the plain-list path applies them client-side over the page (the list endpoint
 * has no party param) — NEVER widening visibility.
 */
function GroupedAllDocuments({
  archived,
  canCreate,
  searchQuery,
}: {
  archived: boolean;
  canCreate: boolean;
  searchQuery?: string;
}) {
  const t = useTranslations('documents');
  const [partyFacet, setPartyFacet] = useState<DocumentParty | null>(null);
  const [scopeFacet, setScopeFacet] = useState<ScopeFacet | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  useEffect(() => setCursor(undefined), [partyFacet, scopeFacet, searchQuery, archived]);

  const searching = Boolean(searchQuery && searchQuery.length > 0);

  const search = useDocumentSearch(
    {
      q: searchQuery ?? '',
      limit: PAGE_LIMIT,
      cursor,
      ...(partyFacet ? { party: partyFacet } : {}),
      ...(scopeFacet ? { scope: scopeFacet } : {}),
      archived,
    },
    { enabled: searching },
  );
  const list = useDocumentList({ limit: PAGE_LIMIT, cursor, archived });

  const active = searching ? search : list;
  const activeItems = active.data?.items;
  const page = active.data?.page;

  const items = useMemo(() => {
    const raw = activeItems ?? [];
    if (searching) return raw;
    let out = raw;
    if (partyFacet) out = out.filter((d) => providerPartyForDocType(d.type) === partyFacet);
    if (scopeFacet) out = out.filter((d) => documentScope(d) === scopeFacet);
    return out;
  }, [activeItems, searching, partyFacet, scopeFacet]);

  const pendingScan = items.filter((d) => d.scanStatus === 'pending').length;
  const ghostUploads = items.filter((d) => !d.isScanClean && d.scanStatus !== 'pending').length;

  const groups = useMemo(() => groupByProjectParty(items, t('group.unassigned')), [items, t]);

  return (
    <div className="flex flex-col gap-4">
      <FacetRail
        partyFacet={partyFacet}
        scopeFacet={scopeFacet}
        onParty={setPartyFacet}
        onScope={setScopeFacet}
      />

      {(pendingScan > 0 || ghostUploads > 0) && (
        <div className="flex flex-wrap items-center gap-2" role="status">
          {pendingScan > 0 && (
            <span className="badge badge-neutral">
              {t('grouped.pendingScan', { count: pendingScan })}
            </span>
          )}
          {ghostUploads > 0 && (
            <span className="badge badge-warning">
              {t('grouped.ghostUploads', { count: ghostUploads })}
            </span>
          )}
        </div>
      )}

      <DataState
        isLoading={active.isLoading}
        isError={active.isError}
        onRetry={() => void active.refetch()}
        skeleton="list"
        isEmpty={items.length === 0}
        emptyTitle={searching ? t('noResults') : archived ? t('archivedEmpty') : t('empty')}
        emptyAction={
          canCreate && !archived && !searching ? (
            <Link href="/documents/new" className="btn btn-primary btn-sm">
              <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
              <span>{t('upload')}</span>
            </Link>
          ) : undefined
        }
      >
        <ul className="flex flex-col gap-3">
          {groups.map((g) => (
            <li key={g.key}>
              <ProjectGroup
                group={g}
                canCreate={canCreate}
                onArchived={() => void active.refetch()}
              />
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

/** The facet rail — party + scope chips. The header search box is the third
 *  facet. Calm chips; selecting toggles the facet. */
function FacetRail({
  partyFacet,
  scopeFacet,
  onParty,
  onScope,
}: {
  partyFacet: DocumentParty | null;
  scopeFacet: ScopeFacet | null;
  onParty: (p: DocumentParty | null) => void;
  onScope: (s: ScopeFacet | null) => void;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const scopes: ScopeFacet[] = ['project', 'apartment', 'org'];

  return (
    <div className="flex flex-col gap-2" aria-label={t('facet.label')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-text-muted">{t('facet.party')}:</span>
        <FacetChip
          active={partyFacet === null}
          onClick={() => onParty(null)}
          label={t('facet.all')}
        />
        {DOCUMENT_PARTIES.map((p) => (
          <FacetChip
            key={p}
            active={partyFacet === p}
            onClick={() => onParty(partyFacet === p ? null : p)}
            label={tParty(p)}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-text-muted">{t('facet.scopeLabel')}:</span>
        <FacetChip
          active={scopeFacet === null}
          onClick={() => onScope(null)}
          label={t('facet.all')}
        />
        {scopes.map((s) => (
          <FacetChip
            key={s}
            active={scopeFacet === s}
            onClick={() => onScope(scopeFacet === s ? null : s)}
            label={t(`facet.scope.${s}`)}
          />
        ))}
      </div>
    </div>
  );
}

function FacetChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
      style={{
        background: active ? 'var(--text)' : 'var(--bg-surface)',
        color: active ? 'var(--bg-surface)' : 'var(--text-muted)',
        border: active ? 'none' : '1px solid var(--border)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

interface PartySubgroup {
  party: DocumentParty;
  docs: DocumentViewModel[];
}
interface ProjectGroupModel {
  key: string;
  projectId: string | null;
  projectName: string;
  count: number;
  subgroups: PartySubgroup[];
}

/** One collapsible project group: a header (project name + doc count) over the
 *  party subgroups (each a small label + its `DocumentRow` leaves). Collapsible
 *  via a native disclosure button (keyboard-operable). Open by default. */
function ProjectGroup({
  group,
  canCreate,
  onArchived,
}: {
  group: ProjectGroupModel;
  canCreate: boolean;
  onArchived: () => void;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const [open, setOpen] = useState(true);
  const panelId = `group-${group.key}`;

  return (
    <div className="card flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-start transition-colors hover:bg-surface-subtle"
        style={{ cursor: 'pointer' }}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        ) : (
          <ChevronLeft className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        )}
        <Building2 className="h-4 w-4 shrink-0 text-navy-700" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          <NameDisplay name={group.projectName} />
        </span>
        <span className="shrink-0 text-xs text-text-muted">
          {t('grouped.groupCount', { count: group.count })}
        </span>
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-3 border-t border-border px-3 py-3">
          {group.subgroups.map((sg) => (
            <div key={sg.party} className="flex flex-col gap-1.5">
              <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-soft">
                {tParty(sg.party)}
              </span>
              <ul className="flex flex-col gap-1.5">
                {sg.docs.map((d) => (
                  <li key={d.id}>
                    <DocumentRow doc={d} canCreate={canCreate} onArchived={onArchived} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Project zoom-in — LEADS with the core-document checklist ─────────────────

/** Server-paginated project zoom-in (S2 gap #3) — LEADS with the required-vs-
 *  received core-document checklist board (the previously-unsurfaced
 *  `GET /projects/:id/document-checklist`); missing slots are one-click uploads.
 *  THEN the project's own documents (server-paginated). */
function ProjectZoomIn({
  project,
  archived,
  canCreate,
  onBack,
}: {
  project: ProjectRef;
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
    <div className="flex flex-col gap-4">
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
        {/* X-S6/X-S7 — "invite a party" SHARE-TO verb (additive). */}
        <ProjectShareControls project={project} />
      </div>

      {/* LEAD — the core-document checklist (required-vs-received), missing = upload. */}
      <ProjectChecklistBoard projectId={project.id} canCreate={canCreate} />

      {/* THEN — the project's documents. */}
      <h2 className="text-sm font-semibold text-foreground">{t('checklistBoard.docsHeading')}</h2>
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

/**
 * X-S6/X-S7 — the "invite a party" (SHARE-TO) controls for a project zoom-in.
 * Self-contained + ADDITIVE (composes the shared share-sheet + activity panel —
 * does NOT re-implement sharing; reuses the `external_share` canonical seam). The
 * "invite a party" button is gated on `shares.create` (the BE create permission;
 * the service further enforces manager-only). The active-shares panel is a
 * collapsible disclosure so the zoom-in stays calm by default.
 */
function ProjectShareControls({ project }: { project: ProjectRef }) {
  const tShare = useTranslations('externalShare');
  const canShare = useHasPermission('shares.create');
  const { open, sheet } = useShareSheet();
  const [showPanel, setShowPanel] = useState(false);

  if (!canShare) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => open({ scopeType: 'project', scopeIds: [project.id], label: project.name })}
        className="btn btn-secondary btn-sm"
        data-testid="project-invite-party"
      >
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{tShare('openButton')}</span>
      </button>
      <button
        type="button"
        onClick={() => setShowPanel((v) => !v)}
        aria-expanded={showPanel}
        className="inline-flex items-center gap-1 text-xs font-medium text-text-muted"
        style={{ cursor: 'pointer' }}
      >
        {showPanel ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>{tShare('activity.heading')}</span>
      </button>
      {showPanel && (
        <div className="w-full">
          <ShareActivityPanel enabled={showPanel} />
        </div>
      )}
      {sheet}
    </>
  );
}

/**
 * The per-project core-document CHECKLIST board (S2 gap #3) — the previously-
 * unsurfaced `GET /projects/:id/document-checklist`. Each MISSING required slot
 * is a row (missing + a one-click "העלה {type}" deep-link, grouped by the
 * responsible party); a calm summary line + completeness sliver lead. The
 * received slots are summarised by the count (the checklist VM carries only the
 * missing type keys — no fabricated present types). Fail-soft: no track / failed
 * checklist renders a calm note, never a blank, and never blocks the docs below.
 */
function ProjectChecklistBoard({
  projectId,
  canCreate,
}: {
  projectId: string;
  canCreate: boolean;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const { data, isLoading } = useDocumentChecklist(projectId);

  if (isLoading) {
    return (
      <section className="card card-pad">
        <p className="text-xs text-text-muted">{t('cockpit.pulse.loading')}</p>
      </section>
    );
  }
  if (!data || data.totalCount === 0) {
    return (
      <section className="card card-pad">
        <p className="text-xs text-text-muted">{t('checklistBoard.noTrack')}</p>
      </section>
    );
  }

  const pct = data.totalCount > 0 ? Math.round((data.presentCount / data.totalCount) * 100) : 0;

  return (
    <section className="card card-pad flex flex-col gap-3" aria-label={t('checklistBoard.heading')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t('checklistBoard.heading')}</h2>
        <span className="text-xs text-text-muted tabular-nums">
          {data.isComplete
            ? t('checklistBoard.complete')
            : t('checklistBoard.summary', {
                received: data.presentCount,
                required: data.totalCount,
              })}
        </span>
      </div>
      <ThresholdSliver consentedPct={pct} metThreshold={data.isComplete} />

      {/* The received summary (the present slots — VM carries only missing keys). */}
      {data.presentCount > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Check
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: 'var(--success-600)' }}
            aria-hidden="true"
          />
          {t('checklistBoard.summary', { received: data.presentCount, required: data.totalCount })}
        </p>
      )}

      {/* The MISSING required slots — each a one-click upload, grouped by party. */}
      {data.missing.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {data.missing.map((m) => {
            const party = providerPartyForDocType(m.type);
            return (
              <li
                key={m.type}
                className="flex items-center justify-between gap-2 rounded-md bg-surface-subtle px-2.5 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2 text-xs">
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border"
                    style={{ borderColor: 'var(--warning-600)' }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-foreground">
                    {t('checklistBoard.missing', { type: m.typeLabel })}
                  </span>
                  <span className="shrink-0 text-text-soft">· {tParty(party)}</span>
                </span>
                {canCreate && (
                  <Link
                    href={`/documents/new?type=${encodeURIComponent(m.type)}&party=${party}&projectId=${projectId}`}
                    className="btn btn-secondary btn-sm shrink-0"
                    aria-label={t('checklistBoard.uploadAria', { type: m.typeLabel })}
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('board.uploadMissing', { type: m.typeLabel })}</span>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── A single legible document row + its quick actions ───────────────────────

/**
 * One document row — legible at a glance: the icon + name, the type + project
 * (+ apartment when present) always visible, a SENSITIVE/scan marker when
 * relevant, a de-emphasized size/date, and quick actions (download + archive).
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
 *  unlock for sensitive docs + the same safe new-tab open as the detail page. */
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
 *  on success and shows a calm toast. */
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

// ── Pure helpers (grouping + scope) ─────────────────────────────────────────

/** Resolve a document's SCOPE facet from its parent linkage. */
function documentScope(d: DocumentViewModel): ScopeFacet {
  if (d.apartmentId) return 'apartment';
  if (d.projectId) return 'project';
  return 'org';
}

/**
 * Group documents by project → party (party subgroups in canonical order). The
 * project header uses the resolved `projectName` label; org-level docs (no
 * project) fall into one "unassigned" group LAST. Pure + deterministic.
 */
function groupByProjectParty(
  docs: DocumentViewModel[],
  unassignedLabel: string,
): ProjectGroupModel[] {
  const byProject = new Map<string, ProjectGroupModel>();
  for (const d of docs) {
    const key = d.projectId ?? '__org__';
    let g = byProject.get(key);
    if (!g) {
      g = {
        key,
        projectId: d.projectId,
        projectName: d.projectName ?? unassignedLabel,
        count: 0,
        subgroups: [],
      };
      byProject.set(key, g);
    }
    g.count += 1;
    const party = providerPartyForDocType(d.type);
    let sg = g.subgroups.find((s) => s.party === party);
    if (!sg) {
      sg = { party, docs: [] };
      g.subgroups.push(sg);
    }
    sg.docs.push(d);
  }
  for (const g of byProject.values()) {
    g.subgroups.sort(
      (a, b) => DOCUMENT_PARTIES.indexOf(a.party) - DOCUMENT_PARTIES.indexOf(b.party),
    );
  }
  return [...byProject.values()].sort((a, b) => {
    if (a.projectId === null) return 1;
    if (b.projectId === null) return -1;
    return a.projectName.localeCompare(b.projectName);
  });
}

// ── Party-document accumulator (server-paginated, party-bucketed) ───────────

/**
 * Accumulate ONE party's documents by paging the documents LIST endpoint and
 * keeping only the rows that roll up to this party. The party board's headline
 * count comes from the SERVER summary (never this); this only materializes the
 * rows on demand, paging until the board is exhausted (progressive disclosure).
 */
function usePartyDocuments(party: DocumentParty, archived: boolean) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [acc, setAcc] = useState<DocumentViewModel[]>([]);
  const [exhausted, setExhausted] = useState(false);

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
      void refetch();
    },
  };
}
