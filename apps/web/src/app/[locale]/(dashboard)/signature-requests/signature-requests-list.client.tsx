'use client';

import type { SignatureRequestStatus } from '@emapp/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSignaturePulse } from '@/hooks/use-signature-pulse';
import { useSignatureRequestList } from '@/hooks/use-signature-requests';
import type { SignatureRequestViewModel } from '@/models/signature-request.vm';

import {
  ActionCard,
  AllClearBadge,
  buildPulseSentence,
  FleetSection,
} from '../_components/situation-picture';

const STATUS_FILTERS: (SignatureRequestStatus | 'all')[] = [
  'all',
  'pending',
  'signed',
  'cancelled',
];

/** Flat-list sort order. `newest` (default) = created-at-DESC, the BE's native
 *  keyset order; `oldest` re-orders the loaded page ascending. Sort is over the
 *  ALREADY-LOADED rows (keyset pages are server-ordered DESC), so it re-orders
 *  what's on screen — a scannability aid, not a re-query. */
type SigSort = 'newest' | 'oldest';
const SIG_SORTS: SigSort[] = ['newest', 'oldest'];

/** The three situation-picture views. Default `attention` = the ranked
 *  "needs you now" board (NOT the flat wall); `fleet` = every project as a
 *  zoom-in tile; `all` = the preserved flat forensic list of every request. */
type SigView = 'attention' | 'fleet' | 'all';
const SIG_VIEWS: SigView[] = ['attention', 'fleet', 'all'];

/**
 * Signatures situation-picture (signature-requests redesign Slice 1).
 *
 * REPLACES the flat `<ul>` wall (a wall of near-identical timestamps that only
 * read at demo scale) with the SAME board-first 3-tier pattern as the home
 * (E2.1), REUSING the shared `situation-picture/` primitives (ONE source of
 * truth, no duplication):
 *
 *   • Tier 0 — the pulse header: one plain-Hebrew sentence summarising the org's
 *     signature state from the pulse `buckets`.
 *   • Tier 1 — "צריך טיפול": the server-ranked attention project groups (most-
 *     urgent first), each with its reason chip + consent sliver + the inline
 *     holdout drill-down + one-click chase. This is the DEFAULT view.
 *   • Tier 2 — "כל הפרויקטים": the full fleet as compact zoom-in tiles (capped,
 *     with a "הצג הכל" escape-hatch to /projects).
 *   • "כל הבקשות" — the EXISTING flat list preserved VERBATIM (status filter +
 *     load-more + per-request links) as the forensic secondary view.
 *
 * Data: all existing endpoints — `org/signature-pulse` (Tiers 0-2, scope-aware
 * on the BE: manager/viewer → whole org, agent → assigned only), the
 * signature-request list (the flat view), and the holdouts/chase the shared
 * primitives already own. NO new endpoint, NO new PII, NO backend change.
 *
 * RSC prefetch: `page.tsx` server-prefetches BOTH the list AND the pulse, so on
 * a cold load every tier hydrates SYNCHRONOUSLY from the dehydrated cache — no
 * client fetch fires on first paint; on prefetch failure each hook falls back to
 * its own skeleton/error path.
 */
export function SignatureRequestsListClient() {
  const t = useTranslations('signatureRequests');
  // The board primitives speak the signature-centric `home.pulse` copy (shared
  // with the home) — Tier 0-2 strings come from there, not `signatureRequests`.
  const tPulse = useTranslations('home.pulse');
  const tConsent = useTranslations('consent');

  const [view, setView] = useState<SigView>('attention');
  // IAM slice 5b — "create" CTA gated on `signature_requests.send`. The remind /
  // chase actions inside the board are gated on the SAME permission (Viewer
  // never mutates); "open project" stays a read-navigation for every role.
  const canCreate = useHasPermission('signature_requests.send');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/signature-requests/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      {/* Tier 0 — the pulse header sentence (always visible above the toggle). */}
      <SignaturePulseHeader tPulse={tPulse} />

      {/* View toggle: צריך טיפול (default) | כל הפרויקטים | כל הבקשות. */}
      <div
        role="tablist"
        aria-label={t('view.label')}
        className="flex flex-wrap items-center gap-2"
      >
        {SIG_VIEWS.map((v) => (
          <Button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            variant={view === v ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView(v)}
          >
            {t(`view.${v}`)}
          </Button>
        ))}
      </div>

      {view === 'attention' && (
        <AttentionBoard tPulse={tPulse} basisLabel={tConsent('basisShare')} canRemind={canCreate} />
      )}
      {view === 'fleet' && <FleetBoard tPulse={tPulse} />}
      {view === 'all' && <FlatRequestList />}
    </div>
  );
}

/** Tier 0 — the one calm pulse sentence. Resolves from the SAME `signature-pulse`
 *  query the board tiers read; a loading/empty pulse renders the calm subtitle
 *  rather than a blank. */
function SignaturePulseHeader({ tPulse }: { tPulse: ReturnType<typeof useTranslations> }) {
  const pulse = useSignaturePulse();
  const vm = pulse.data;

  return (
    <p className="text-sm text-text" role="status">
      {vm ? buildPulseSentence(tPulse, vm.buckets) : tPulse('subtitleLoading')}
    </p>
  );
}

/** Tier 1 — "צריך טיפול": the server-ranked attention project groups. Reuses the
 *  home's `ActionCard` (reason chip + consent sliver + holdout drill-down +
 *  one-click chase) verbatim; the calm loading/error/all-clear states route
 *  through the SAME `DataState` the home uses. */
function AttentionBoard({
  tPulse,
  basisLabel,
  canRemind,
}: {
  tPulse: ReturnType<typeof useTranslations>;
  basisLabel: string;
  canRemind: boolean;
}) {
  const pulse = useSignaturePulse();
  const vm = pulse.data;

  return (
    <section aria-label={tPulse('attentionHeading')} className="flex flex-col gap-3">
      <DataState
        isLoading={pulse.isLoading}
        isError={pulse.isError}
        error={pulse.error}
        isEmpty={Boolean(vm?.isAllClear)}
        onRetry={() => void pulse.refetch()}
        skeleton="list"
        emptyTitle={
          vm && vm.totalInScope === 0 ? tPulse('empty.noProjectsTitle') : tPulse('allClear.title')
        }
        emptyHint={
          vm && vm.totalInScope === 0 ? tPulse('empty.noProjectsHint') : tPulse('allClear.hint')
        }
        emptyAction={
          vm && vm.totalInScope === 0 ? undefined : (
            <AllClearBadge label={tPulse('allClear.badge')} />
          )
        }
      >
        {vm && (
          <ul className="flex flex-col gap-3">
            {vm.cards.map((card) => (
              <li key={card.projectId}>
                <ActionCard
                  card={card}
                  canRemind={canRemind}
                  sendEnabled={vm.sendEnabled}
                  t={tPulse}
                  basisLabel={basisLabel}
                />
              </li>
            ))}
          </ul>
        )}

        {/* The calm queue-tail line — reassures that the rest of the portfolio is
            still tracked (not forgotten) without cluttering the triage list.
            N = (total tracked in scope) − (cards shown); suppressed at N=0 and in
            the empty/all-clear state (DataState owns those). */}
        {vm && vm.cards.length > 0 && vm.totalInScope - vm.cards.length > 0 && (
          <p className="text-xs text-text-muted" role="status">
            {tPulse('queueTail', { count: vm.totalInScope - vm.cards.length })}
          </p>
        )}
      </DataState>
    </section>
  );
}

/** Tier 2 — "כל הפרויקטים": the full fleet as compact zoom-in tiles. Reuses the
 *  home's `FleetSection` (capped at FLEET_TILE_CAP with a "הצג הכל" escape-hatch
 *  to /projects). A distinct headingId avoids any id collision if both boards
 *  ever co-render. */
function FleetBoard({ tPulse }: { tPulse: ReturnType<typeof useTranslations> }) {
  const pulse = useSignaturePulse();
  const vm = pulse.data;

  return (
    <DataState
      isLoading={pulse.isLoading}
      isError={pulse.isError}
      error={pulse.error}
      isEmpty={Boolean(vm && vm.fleet.length === 0)}
      onRetry={() => void pulse.refetch()}
      skeleton="list"
      emptyTitle={tPulse('empty.noProjectsTitle')}
      emptyHint={tPulse('empty.noProjectsHint')}
    >
      {vm && vm.fleet.length > 0 && (
        <FleetSection
          fleet={vm.fleet}
          fleetCapped={vm.fleetCapped}
          totalInScope={vm.totalInScope}
          headingId="signatures-fleet"
        />
      )}
    </DataState>
  );
}

/** A `(projectId, projectName)` option for the flat-list project filter. */
interface ProjectFilterOption {
  id: string;
  name: string;
}

/**
 * "כל הבקשות" — the flat forensic list, now LEGIBLE at scale (Slice 3).
 *
 * Each row reads project · owner (masked-by-default) · document · status ·
 * relative time instead of a bare status pill + timestamp, consuming the
 * enriched wire the BE returns (slice 2, `SignatureRequestListItem`). At N=hundreds
 * the manager can scan WHICH project / WHOSE / WHAT — not a wall of identical
 * timestamps.
 *
 * Controls (all preserve the existing keyset load-more cursor):
 *   - STATUS filter — the existing server-side `status` filter (re-queries).
 *   - PROJECT filter — the Slice-2 `projectId` server filter; options are DERIVED
 *     from the pulse fleet (ONE source of truth for "projects in scope", already
 *     prefetched — no new fetch, no drift). Re-queries server-side.
 *   - SORT — newest / oldest, a client-side re-order of the loaded rows.
 *
 * PII: `ownerDisplay` is the server's masked-by-default value — `null` for a
 * caller lacking `view_owner_pii`. The row renders the neutral "owner masked"
 * placeholder in that case and NEVER reconstructs a name; when present it is
 * wrapped in `<NameDisplay>` (bidi-safe).
 */
function FlatRequestList() {
  const t = useTranslations('signatureRequests');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<SignatureRequestStatus | 'all'>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [sort, setSort] = useState<SigSort>('newest');

  // Project-filter options derive from the pulse fleet — the SAME in-scope
  // project set the board tiers read (one source of truth; already prefetched).
  const pulse = useSignaturePulse();
  const projectOptions: ProjectFilterOption[] = useMemo(
    () => (pulse.data?.fleet ?? []).map((f) => ({ id: f.projectId, name: f.projectName })),
    [pulse.data],
  );

  const { data, isLoading, isError, error, refetch } = useSignatureRequestList({
    limit: 25,
    cursor,
    ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
    ...(projectFilter !== 'all' ? { projectId: projectFilter } : {}),
  });

  const page = data?.page;

  // Sort the loaded page. Keyset pages arrive created-DESC from the server; for
  // 'oldest' we reverse the loaded window (re-order, not re-query). Deriving from
  // `data` (not an intermediate `?? []`) keeps the memo deps stable across renders.
  const sortedItems = useMemo(() => {
    const copy = [...(data?.items ?? [])];
    copy.sort((a, b) =>
      sort === 'newest' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs,
    );
    return copy;
  }, [data, sort]);

  const resetPaging = () => setCursor(undefined);

  return (
    <div className="space-y-6">
      {/* Controls row — status filter · project filter · sort. */}
      <div className="flex flex-col gap-3">
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('statusFilterLabel')}
        >
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              type="button"
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setStatusFilter(s);
                resetPaging();
              }}
            >
              {t(`statusFilter.${s}`)}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {projectOptions.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-text">
              <span className="text-text-muted">{t('projectFilterLabel')}</span>
              <select
                className="rounded-md border bg-card px-2 py-1 text-sm"
                value={projectFilter}
                onChange={(e) => {
                  setProjectFilter(e.target.value);
                  resetPaging();
                }}
              >
                <option value="all">{t('projectFilterAll')}</option>
                {projectOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center gap-2 text-sm text-text">
            <span className="text-text-muted">{t('sortLabel')}</span>
            <select
              className="rounded-md border bg-card px-2 py-1 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as SigSort)}
            >
              {SIG_SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`sort.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <DataState
        isLoading={isLoading}
        isError={isError}
        error={error}
        isEmpty={sortedItems.length === 0}
        onRetry={() => void refetch()}
        skeleton="list"
        emptyTitle={statusFilter === 'pending' ? t('allClear.title') : t('emptyFilteredTitle')}
        emptyHint={statusFilter === 'pending' ? t('allClear.hint') : t('emptyFilteredHint')}
        emptyAction={
          statusFilter === 'pending' ? <AllClearBadge label={t('allClear.badge')} /> : undefined
        }
      >
        <ul className="space-y-2">
          {sortedItems.map((r) => (
            <SignatureRequestRow key={r.id} r={r} />
          ))}
        </ul>

        {page?.has_more && page.cursor && (
          <div className="mt-4 flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setCursor(page.cursor ?? undefined)}>
              {tp('next')}
            </Button>
            {cursor && (
              <Button variant="ghost" size="sm" onClick={resetPaging}>
                {tp('resetToFirstPage')}
              </Button>
            )}
          </div>
        )}
        {!page?.has_more && cursor && (
          <Button className="mt-4" variant="ghost" size="sm" onClick={resetPaging}>
            {tp('resetToFirstPage')}
          </Button>
        )}
      </DataState>
    </div>
  );
}

/**
 * One legible flat-list row. Lead line = project + apartment (the WHERE); the
 * owner (the WHO, masked-by-default) and the document (the WHAT) sit on the
 * second line with the status pill; the timestamps trail. Whole row links to
 * the request detail (the zoom-in). Names are `<NameDisplay>`-wrapped.
 */
function SignatureRequestRow({ r }: { r: SignatureRequestViewModel }) {
  const t = useTranslations('signatureRequests');

  const projectLabel = r.projectName ?? t('noProject');
  const apartmentSuffix = r.apartmentLabel
    ? ` · ${t('apartmentLabel', { label: r.apartmentLabel })}`
    : '';

  return (
    <li className="rounded-md border bg-card p-4">
      <Link href={`/signature-requests/${r.id}`} className="block">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            {/* WHERE — project + apartment. */}
            <p className="truncate text-sm font-medium text-text">
              <NameDisplay name={projectLabel} bare />
              {apartmentSuffix && <span className="text-text-muted">{apartmentSuffix}</span>}
            </p>

            {/* WHO + WHAT — owner (masked-default) · document. */}
            <p className="truncate text-xs text-text-muted">
              {r.ownerDisplay ? (
                <NameDisplay name={r.ownerDisplay} bare />
              ) : (
                <span>{t('ownerMasked')}</span>
              )}
              {' · '}
              {r.documentName ? <NameDisplay name={r.documentName} bare /> : t('noDocument')}
            </p>

            {/* WHEN — the timestamps. */}
            <p className="text-xs text-text-muted">
              {t('createdAt', { rel: r.createdRelative })}
              {r.status === 'pending' && !r.isExpired && (
                <> · {t('expiresAt', { rel: r.expiresRelative })}</>
              )}
              {r.signedRelative && <> · {t('signedAt', { rel: r.signedRelative })}</>}
              {r.cancelledRelative && <> · {t('cancelledAt', { rel: r.cancelledRelative })}</>}
            </p>
          </div>

          {/* Status at a glance — pill + expired flag. */}
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge intent={r.intent}>{r.statusLabel}</StatusBadge>
            {r.isExpired && <span className="badge badge-danger">{t('expired')}</span>}
          </div>
        </div>
      </Link>
    </li>
  );
}
