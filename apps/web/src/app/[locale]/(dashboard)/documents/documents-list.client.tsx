'use client';

import type { PartyCompleteness } from '@emapp/shared-types';
import {
  ArrowRight,
  Building2,
  Check,
  ClipboardCheck,
  Compass,
  FileSignature,
  FileText,
  Files,
  HardHat,
  Plus,
  Ruler,
  Scale,
  Search,
  UserCheck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ComponentType } from 'react';
import { useMemo, useState } from 'react';

import { DOCUMENT_TYPE_LABELS_EN, DOCUMENT_TYPE_LABELS_HE } from '@/adapters/document';
import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useBoardCompleteness, useDocumentList } from '@/hooks/use-documents';
import { useHasPermission } from '@/hooks/use-permissions';
import { useProjectList } from '@/hooks/use-projects';
import {
  DOCUMENT_PARTIES,
  type DocumentParty,
  providerPartyForDocType,
} from '@/lib/document-party';
import { useDisplayLocale } from '@/lib/locale';
import type { DocumentViewModel } from '@/models/document.vm';

/**
 * Documents page — PARTY BINDER board (V13 doc-management re-skin, slice 1).
 *
 * Owner complaint this kills: "still מבולגן — a wall of files that doesn't
 * scale and bores the technophobe." The earlier surface grouped docs by
 * project + a per-project required-docs checklist; useful, but the LANDING
 * was still a list of files.
 *
 * This slice re-skins the DEFAULT view into a calm grid of ~8 PARTY cards
 * ("who is responsible": בעלים / שמאי / אדריכל / עירייה / קבלן / עו״ד /
 * מפקח / מודד / כללי). The party axis is DERIVED FE-side from the `doc_type`
 * the read model already carries (`providerPartyForDocType`) — there is NO
 * migration and NO new BE endpoint; this is presentation over data the page
 * already fetches.
 *
 * Two clicks to a file (the calm-at-a-glance contract):
 *   1. Landing = party cards. NO filenames. Each card shows the party name, a
 *      one-line gist (count + the latest doc), and a quiet completeness mark
 *      (teal check when present, neutral ring for empty). A party with zero
 *      docs renders as a quiet GHOST card.
 *   2. Clicking a card ZOOMS IN to that party's actual documents, grouped by
 *      doc_type — this is where filenames appear (in-page; no new route).
 *
 * Search + active/archived + upload affordances are preserved. Per-project
 * completeness (the old checklist) is deferred to slice 2 (completeness-per-
 * party); this slice keeps the gist derived purely from the docs on the page.
 */

/** Per-party icon + accent token. Color is reserved for ATTENTION only —
 *  here the accent tints the small icon tile, never a full card fill. */
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

interface PartyBucket {
  party: DocumentParty;
  docs: DocumentViewModel[];
  /** The most-recently-created doc, used for the card gist. */
  latest: DocumentViewModel | null;
}

export function DocumentsListClient() {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  // Active (default) vs archived view — soft-archived docs are otherwise
  // invisible in the cockpit. Switching resets pagination.
  const [archived, setArchived] = useState(false);
  // The zoomed-in party (slice-1 "two clicks deep"). null = the board.
  const [activeParty, setActiveParty] = useState<DocumentParty | null>(null);
  // IAM slice 5b — "upload" CTA (creates a document) gated on `documents.create`.
  const canCreate = useHasPermission('documents.create');
  const { data, isLoading, isError, refetch } = useDocumentList({ limit: 25, cursor, archived });

  // Project id → name, so the zoomed-in file rows can show the owning project.
  const { data: projectsData } = useProjectList({ limit: 100 });
  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsData?.items ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsData?.items]);

  // Binder slice 2 — per-party REQUIRED-vs-RECEIVED completeness, computed
  // SERVER-SIDE over the WHOLE board scope (org / agent's assigned projects).
  // This REPLACES the earlier client-side `computeBoardCompleteness` over a
  // single 25-doc page: that compared a partial page against ALL projects'
  // requirements, so unloaded projects were mis-counted "missing" (bogus
  // "owners 0/21"). The board is keyset-paginated — only the server sees every
  // doc. Fail-SOFT: when the query is loading/errored, `completenessByParty` is
  // null and the cards fall back to the calm slice-1 "present" check.
  const { data: boardCompleteness } = useBoardCompleteness();
  const completenessByParty = useMemo<Map<DocumentParty, PartyCompleteness> | null>(() => {
    if (!boardCompleteness) return null;
    const map = new Map<DocumentParty, PartyCompleteness>();
    for (const c of boardCompleteness.byParty) map.set(c.party, c);
    return map;
  }, [boardCompleteness]);

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const page = data?.page;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (d) => d.name.toLowerCase().includes(q) || d.typeLabel.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Derive the party axis: every shown doc → exactly one of the 8 parties,
  // purely from its `type` (the tolerant wire string). Buckets are keyed in
  // the canonical `DOCUMENT_PARTIES` order so the board is stable.
  const buckets = useMemo<PartyBucket[]>(() => {
    const byParty = new Map<DocumentParty, DocumentViewModel[]>();
    for (const d of filteredItems) {
      const party = providerPartyForDocType(d.type);
      const bucket = byParty.get(party);
      if (bucket) bucket.push(d);
      else byParty.set(party, [d]);
    }
    return DOCUMENT_PARTIES.map((party) => {
      const docs = byParty.get(party) ?? [];
      // "latest" = the most-relevant fact for the gist. The list is keyset-
      // ordered newest-first, so the first doc in the bucket is the latest.
      const latest = docs[0] ?? null;
      return { party, docs, latest };
    });
  }, [filteredItems]);

  // Plain-Hebrew orientation, user-voiced (the user's situation, never "the
  // system did X"). It now reads the SERVER completeness (real unmet REQUIREMENTS
  // across the whole board scope, NOT a single page). The "ועוד N" is the count
  // of parties whose required doc-set is incomplete, ordered in the canonical
  // board order so the named parties read stably. Falls back to the slice-1
  // presence framing when there is no requirement anywhere, or while the
  // completeness query is still loading (so the line never flashes wrong).
  const orientation = useMemo(() => {
    const active = buckets.filter((b) => b.docs.length > 0);
    if (active.length === 0) return null; // empty-state copy handles this
    if (boardCompleteness?.hasAnyRequirement) {
      const unmet = DOCUMENT_PARTIES.filter((p) => boardCompleteness.unmetParties.includes(p));
      return { kind: 'requirement' as const, parties: unmet };
    }
    const empty = buckets.filter((b) => b.docs.length === 0).map((b) => b.party);
    return { kind: 'presence' as const, parties: empty };
  }, [buckets, boardCompleteness]);

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

  const activeBucket = activeParty ? (buckets.find((b) => b.party === activeParty) ?? null) : null;

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
                  setActiveParty(null);
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

      {/* Plain-Hebrew orientation — states the situation in words, user-voiced. */}
      {orientation && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          <OrientationLine kind={orientation.kind} parties={orientation.parties} />
        </p>
      )}

      {filteredItems.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {items.length === 0 ? t('empty') : t('noResults')}
        </p>
      ) : activeBucket ? (
        <PartyZoomIn
          bucket={activeBucket}
          projectNames={projectNames}
          onBack={() => setActiveParty(null)}
        />
      ) : (
        <ul
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          aria-label={t('listTitle')}
        >
          {buckets.map((bucket) => (
            <li key={bucket.party}>
              <PartyCard
                bucket={bucket}
                completeness={completenessByParty?.get(bucket.party) ?? null}
                onOpen={() => setActiveParty(bucket.party)}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Pagination — only meaningful on the board (the zoom-in is a filter of
          the current page; loading more docs there would change the board). */}
      {!activeBucket && (
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
      )}
    </div>
  );
}

/**
 * The plain-Hebrew orientation sentence. User-voiced (the user's situation,
 * never "the system did X").
 *
 * Slice 2 — `kind` selects the framing:
 *   - `requirement`: the board HAS track-required docs. `parties` are those whose
 *     REQUIRED set is incomplete. Empty → "all in order" (every requirement met).
 *     Non-empty → "כמעט הכל מסודר — טרם התקבלו מ{parties}", derived from
 *     real required-vs-received (NOT mere presence).
 *   - `presence`: no requirement exists on the board (fallback to the slice-1
 *     framing). `parties` are those still awaiting a FIRST doc.
 *
 * Either way the party list is capped at two names, then "+N", so the read stays
 * calm at scale.
 */
function OrientationLine({
  kind,
  parties,
}: {
  kind: 'requirement' | 'presence';
  parties: DocumentParty[];
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');

  if (parties.length === 0) return <>{t('board.orientation.allFilled')}</>;

  const names = parties.map((p) => tParty(p));
  let partiesText: string;
  if (names.length === 1) {
    partiesText = names[0]!;
  } else if (names.length === 2) {
    partiesText = t('board.orientation.twoParties', { first: names[0]!, second: names[1]! });
  } else {
    partiesText = t('board.orientation.manyParties', { first: names[0]!, count: names.length - 1 });
  }
  const key =
    kind === 'requirement' ? 'board.orientation.someUnmet' : 'board.orientation.someEmpty';
  return <>{t(key, { parties: partiesText })}</>;
}

/**
 * One PARTY card on the landing board. Calm by default: a tinted icon tile,
 * the party name, a one-line gist (count + latest), and a REQUIRED-vs-RECEIVED
 * completeness indicator (binder slice 2).
 *
 * Completeness (`completeness`, may be null when no project context):
 *   - HAS a requirement → an "X/Y" badge + a quiet ring colored by met/unmet
 *     (success when complete, neutral-amber when still outstanding). Replaces the
 *     slice-1 binary teal check.
 *   - NO requirement → just a calm "present" check (this party has docs but no
 *     track-required set), or nothing extra on a ghost.
 *
 * A party with zero docs renders as a GHOST card (muted) and is NOT clickable —
 * but now it surfaces the GAP: when that party HAS an unmet requirement it shows
 * "חסר: <types>" / "0/Y" so the user sees what's missing, not a flat "none".
 */
function PartyCard({
  bucket,
  completeness,
  onOpen,
}: {
  bucket: PartyBucket;
  completeness: PartyCompleteness | null;
  onOpen: () => void;
}) {
  const t = useTranslations('documents');
  const tParty = useTranslations('documents.party');
  const locale = useDisplayLocale();
  const { party, docs, latest } = bucket;
  const Icon = PARTY_META[party].icon;
  const isEmpty = docs.length === 0;
  const name = tParty(party);

  const hasRequirement = completeness?.hasRequirement ?? false;
  const isComplete = completeness?.isComplete ?? false;
  const labels = locale === 'he' ? DOCUMENT_TYPE_LABELS_HE : DOCUMENT_TYPE_LABELS_EN;
  // The missing required types, label-resolved (no PII — type keys only).
  const missingLabels = (completeness?.missingTypes ?? []).map((m) => labels[m.type] ?? m.type);

  if (isEmpty) {
    // Ghost: no docs received. If this party HAS an unmet requirement, surface
    // the GAP ("0/Y · חסר: שומה") so the missing work is visible, not just "none".
    return (
      <div
        className="card flex items-center gap-3 px-4 py-3.5"
        style={{ opacity: 0.7 }}
        aria-disabled="true"
      >
        <PartyIconTile Icon={Icon} muted />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
            {name}
          </span>
          <span className="truncate text-xs" style={{ color: 'var(--text-soft)' }}>
            {hasRequirement && missingLabels.length > 0
              ? t('board.missing', { types: missingLabels.join(' · ') })
              : t('board.ghost')}
          </span>
        </div>
        {hasRequirement && completeness && (
          <CompletenessBadge
            received={completeness.received}
            required={completeness.required}
            unmet
          />
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('board.open', { party: name })}
      className="card flex w-full items-center gap-3 px-4 py-3.5 text-start transition-colors hover:bg-[var(--bg-subtle)] focus:outline-none focus-visible:bg-[var(--bg-subtle)]"
      style={{ cursor: 'pointer' }}
    >
      <PartyIconTile Icon={Icon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {name}
        </span>
        <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
          {hasRequirement && completeness
            ? // Required-vs-received gist — the user's real state per the checklist.
              completeness.received >= completeness.required
              ? t('board.gist.allReceived', { count: docs.length })
              : t('board.gist.someMissing', {
                  received: completeness.received,
                  required: completeness.required,
                  types: missingLabels.join(' · '),
                })
            : latest
              ? t('board.gist.latest', { count: docs.length, when: latest.createdRelative })
              : t('board.gist.count', { count: docs.length })}
        </span>
      </div>
      {hasRequirement && completeness ? (
        <CompletenessBadge
          received={completeness.received}
          required={completeness.required}
          unmet={!isComplete}
        />
      ) : (
        // No track-required set for this party — keep the calm "present" check.
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--success-50)' }}
          title={t('board.complete')}
          aria-hidden="true"
        >
          <Check className="h-3.5 w-3.5" style={{ color: 'var(--success-600)' }} />
        </span>
      )}
    </button>
  );
}

/**
 * The per-party completeness indicator — a quiet "X/Y" count in a soft pill. The
 * tint is the ONLY color signal (success when met, neutral-amber when unmet) so
 * the board stays calm: color = attention, reserved for the unmet case. Counts
 * only — no PII. `aria-label` carries the same fact for assistive tech.
 */
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

/** The small rounded icon tile inside a party card. Teal accent when active,
 *  muted for a ghost (empty) party. */
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
 * The zoomed-in view of ONE party's documents — two clicks deep, where the
 * actual files appear. Reuses the EXISTING file-row rendering, sub-grouped by
 * doc_type (typeLabel) for a stable read. A back affordance returns to the
 * board. No new route — this is in-page state.
 */
function PartyZoomIn({
  bucket,
  projectNames,
  onBack,
}: {
  bucket: PartyBucket;
  projectNames: Map<string, string>;
  onBack: () => void;
}) {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const tParty = useTranslations('documents.party');
  const name = tParty(bucket.party);

  // Sub-group by doc_type label, ordered alphabetically (Hebrew collation).
  const byType = useMemo(() => {
    const map = new Map<string, DocumentViewModel[]>();
    for (const d of bucket.docs) {
      const key = d.typeLabel;
      const list = map.get(key);
      if (list) list.push(d);
      else map.set(key, [d]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he'));
  }, [bucket.docs]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-medium"
          style={{ color: 'var(--text-muted)', cursor: 'pointer' }}
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          {t('board.back')}
        </button>
        <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {name}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('board.gist.count', { count: bucket.docs.length })}
        </span>
      </div>

      <div className="card flex flex-col gap-3 px-4 py-3">
        {byType.map(([typeLabel, typeDocs]) => (
          <div key={typeLabel} className="flex flex-col gap-1.5">
            <div
              className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-soft)' }}
            >
              {typeLabel}
            </div>
            <div className="flex flex-col gap-1.5">
              {typeDocs.map((d) => {
                const projectName = d.projectId ? projectNames.get(d.projectId) : null;
                return (
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
                    {projectName && (
                      <span
                        className="hidden shrink-0 text-[11px] sm:inline"
                        style={{ color: 'var(--text-soft)' }}
                      >
                        <NameDisplay name={projectName} />
                      </span>
                    )}
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
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
