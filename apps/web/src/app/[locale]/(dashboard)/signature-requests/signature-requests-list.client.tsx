'use client';

import type { SignatureRequestStatus } from '@emapp/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataState } from '@/components/ui/data-state';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSignaturePulse } from '@/hooks/use-signature-pulse';
import { useSignatureRequestList } from '@/hooks/use-signature-requests';

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

/**
 * "כל הבקשות" — the EXISTING flat list, preserved VERBATIM (status filter +
 * load-more cursor + per-request links). This is the forensic secondary view:
 * every individual signature request in raw created-at-DESC order, unchanged
 * from the pre-redesign list so nothing is lost for the "find one request" path.
 */
function FlatRequestList() {
  const t = useTranslations('signatureRequests');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<SignatureRequestStatus | 'all'>('all');
  const { data, isLoading, isError, refetch } = useSignatureRequestList({
    limit: 25,
    cursor,
    ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
  });

  if (isLoading) return <ListSkeleton rows={6} />;
  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  const items = data?.items ?? [];
  const page = data?.page;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s}
            type="button"
            variant={statusFilter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setStatusFilter(s);
              setCursor(undefined);
            }}
          >
            {t(`statusFilter.${s}`)}
          </Button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => (
            <li key={r.id} className="rounded-md border bg-card p-4">
              <Link href={`/signature-requests/${r.id}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <StatusBadge intent={r.intent}>{r.statusLabel}</StatusBadge>
                      {r.isExpired && <span className="badge badge-danger">{t('expired')}</span>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('createdAt', { rel: r.createdRelative })}
                      {r.status === 'pending' && !r.isExpired && (
                        <> · {t('expiresAt', { rel: r.expiresRelative })}</>
                      )}
                      {r.signedRelative && <> · {t('signedAt', { rel: r.signedRelative })}</>}
                      {r.cancelledRelative && (
                        <> · {t('cancelledAt', { rel: r.cancelledRelative })}</>
                      )}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

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
  );
}
