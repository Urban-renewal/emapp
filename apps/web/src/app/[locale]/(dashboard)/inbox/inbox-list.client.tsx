'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { toApproveOutcome } from '@/adapters/proposal';
import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { DataState } from '@/components/ui/data-state';
import {
  useApproveProposal,
  useInboxFeed,
  useProposalsPendingCount,
  useRejectProposal,
} from '@/hooks/use-proposals';
import type { ProposalApproveOutcome, ProposalViewModel } from '@/models/proposal.vm';

import { ProposalCard } from './_components/proposal-card';

/** How long the outcome confirmation lingers (long enough to read; calm). */
const OUTCOME_TOAST_MS = 4000;

/** Display ceiling for the lead-line count — a RENDER cap (never a lie): a true
 *  total above this shows "99+" so the header stays calm, while the underlying
 *  count is still the honest org-wide magnitude. */
const COUNT_DISPLAY_CEILING = 99;

/** The canonical order kinds appear in a grouped inbox (attention-shaped: the
 *  contact-producing chase kinds first, suggested tasks last). A kind not listed
 *  falls to the generic group, rendered LAST. */
const KIND_GROUP_ORDER = [
  'signature_request.reissue',
  'reminder.send',
  'document.chase.send',
  'task.create',
] as const;

interface InboxGroup {
  /** The proposal `kind` (or `'generic'` for unmapped kinds). The i18n heading
   *  key is `inbox.group.<kind>`, falling back to `inbox.group.generic`. */
  kind: string;
  /** Whether this group used the generic heading (kind had no mapped label). */
  isGeneric: boolean;
  items: ProposalViewModel[];
}

/**
 * Group the ACCUMULATED inbox feed by proposal `kind` for at-a-glance triage.
 * Pure + deterministic: known kinds appear in `KIND_GROUP_ORDER`; any unmapped
 * kind collapses into ONE trailing `generic` group (never renders a raw kind
 * string). Within a group, order is preserved (the feed is already newest-first).
 *
 * Exported so the accumulate-across-pages invariant is unit-tested directly:
 * grouping the CONCATENATION of two keyset pages must yield ONE group per kind
 * with combined counts (the per-page-grouping illusion this fixes).
 */
export function groupByKind(items: ProposalViewModel[]): InboxGroup[] {
  const known = new Set<string>(KIND_GROUP_ORDER);
  const byKind = new Map<string, ProposalViewModel[]>();
  for (const p of items) {
    const key = known.has(p.kind) ? p.kind : 'generic';
    const bucket = byKind.get(key);
    if (bucket) bucket.push(p);
    else byKind.set(key, [p]);
  }
  const groups: InboxGroup[] = [];
  for (const kind of KIND_GROUP_ORDER) {
    const bucket = byKind.get(kind);
    if (bucket && bucket.length > 0) groups.push({ kind, isGeneric: false, items: bucket });
  }
  const generic = byKind.get('generic');
  if (generic && generic.length > 0) {
    groups.push({ kind: 'generic', isGeneric: true, items: generic });
  }
  return groups;
}

/**
 * Approval Inbox (Autonomous Master Plan, Phase 1) — the autonomy engine's
 * human-confirm surface, SCALE-READY. The user sees the system's PENDING
 * PROPOSALS and confirms each with one click: APPROVE (applies the gated action)
 * or REJECT (dismiss).
 *
 * SITUATION-PICTURE AT SCALE (CLAUDE.md §G-QA SCALE-READY / NO-FLAT): the surface
 * is NOT a flat keyset wall. It LEADS with the HONEST org-wide pending total (the
 * constant-time `GET /proposals/pending-count`, never the ≤25 page length), lets
 * the user narrow by decision TYPE (kind), and GROUPS the accumulated feed by
 * kind so a manager triages at a glance. "Show more" ACCUMULATES pages (the
 * canonical `useInboxFeed`, mirroring `useAllDocumentsFeed`) so the grouping runs
 * over the whole loaded set, with an honesty line stating how many are loaded.
 *
 * VOICE LAW (owner-mandated, non-negotiable): the surface LEADS with the user's
 * pending decisions — "N החלטות ממתינות לך" — never the system's output count
 * ("הבוקר תזמנתי N"). The system is the user's instrument; the per-row CTAs are
 * the user's verbs ([אשר]/[דחה]). Empty state = "אין החלטות ממתינות — הכל מסודר".
 *
 * Manager-only: the BE `requireManager` gate is authoritative; a non-manager
 * gets a 403, which `DataState` renders as the calm access-denied panel (NOT a
 * load error, no retry). RLS isolates per-org.
 *
 * One-click-and-gone: APPROVE / REJECT optimistically remove the row (the hook)
 * and fire an aria-live toast. A failed approve rolls the row back so it stays
 * actionable (M2 — per-item, never silently dropped). On settle the feed resets
 * (re-walks from page 1) so the actioned row truly leaves, and the count
 * invalidates in lockstep (one source of truth).
 */
export function InboxListClient() {
  const t = useTranslations('inbox');
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  // The active decision-TYPE filter (null = all kinds). Narrows server-side via
  // the list endpoint's `?kind`, so the feed resets + re-walks the filtered set.
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  // The HONEST org-wide pending total (constant-time endpoint). This is the lead
  // line's source of truth — NOT the loaded page length.
  const pending = useProposalsPendingCount();
  const trueCount = pending.data?.count ?? 0;

  const feed = useInboxFeed({ ...(kindFilter ? { kind: kindFilter } : {}) });
  const items = feed.items;
  const groups = useMemo(() => groupByKind(items), [items]);

  const approve = useApproveProposal();
  const reject = useRejectProposal();

  /** The lead-line display: the TRUE total, render-capped to "99+" (never a lie —
   *  the cap is cosmetic; the number below it is exact). */
  const countLabel =
    trueCount > COUNT_DISPLAY_CEILING ? `${COUNT_DISPLAY_CEILING}+` : String(trueCount);

  /**
   * Render the delivery OUTCOME confirmation (legibility, G-QA rule #3). Resolves
   * the neutral outcome model → next-intl copy: names the channel + masked
   * recipient on a real send, and stays HONEST (a non-`success` tone routes to the
   * assertive region) so a blocked/failed/no-channel result NEVER reads as "sent".
   */
  function showDeliveryOutcome(outcome: ProposalApproveOutcome) {
    const channelLabel = outcome.channel ? t(`delivery.channel.${outcome.channel}`) : '';
    const message = t(`delivery.${outcome.messageKey}`, {
      channel: channelLabel,
      recipient: outcome.recipient ?? '',
    });
    toast.show({
      message,
      // Only a real send is 'polite' success; every non-send is 'assertive' so
      // the manager can't mistake "nothing went out" for a send.
      variant: outcome.tone === 'warning' ? 'assertive' : 'polite',
      timeoutMs: OUTCOME_TOAST_MS,
    });
  }

  async function onApprove(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      const result = await approve.mutateAsync(id);
      // Contact-producing kinds carry a `delivery` OUTCOME — confirm the real-world
      // result (owner re-contacted, on which channel — or why nothing went out).
      // Internal-only kinds carry no `delivery`; keep the calm generic confirm.
      if (result.delivery) {
        showDeliveryOutcome(toApproveOutcome(result.delivery));
      } else {
        toast.show({ message: t('toast.approved') });
      }
      // Re-walk the feed from page 1 so the actioned row truly leaves the
      // accumulated set (it was optimistically removed from the cache; the
      // accumulator is append-only, so reset is what makes it disappear).
      feed.reset();
    } catch {
      // The hook rolled the row back into the list; surface the failure.
      toast.show({ message: t('toast.failed'), variant: 'assertive' });
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      await reject.mutateAsync(id);
      toast.show({ message: t('toast.rejected') });
      feed.reset();
    } catch {
      toast.show({ message: t('toast.failed'), variant: 'assertive' });
    } finally {
      setBusyId(null);
    }
  }

  // The lead line shows the TRUE count once it's loaded and > 0 (never the page
  // length). Hidden while the count query is still resolving or empty.
  const showLead = !pending.isLoading && !pending.isError && trueCount > 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* Situation header — LEADS with the user's pending decisions (voice law). */}
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('title')}
        </h1>
        {showLead && (
          <p className="text-[15px] font-medium" style={{ color: 'var(--text)' }}>
            {t('pendingLead', { count: trueCount, countLabel })}
          </p>
        )}
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {t('subtitle')}
        </p>
      </header>

      {/* Decision-TYPE filter — narrows the feed server-side by kind (scale: at
          hundreds of pending, the manager scopes to the type he wants to clear). */}
      <KindFilter
        active={kindFilter}
        groupsPresent={groups.map((g) => g.kind)}
        onChange={setKindFilter}
      />

      <DataState
        isLoading={feed.isLoading}
        isError={feed.isError}
        error={feed.error}
        onRetry={() => feed.retry()}
        skeleton="list"
        isEmpty={!feed.isLoading && items.length === 0}
        emptyTitle={t('empty.title')}
        emptyHint={t('empty.hint')}
      >
        {/* HONESTY LINE — a non-technical user must never read the loaded groups
            as "the whole org". Tells him how many of the TRUE total are loaded,
            and that "Show more" loads the rest. */}
        {items.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }} role="status">
            {feed.isExhausted
              ? t('loadedAll', { count: items.length })
              : trueCount > 0
                ? t('loadedPartial', { count: items.length, total: trueCount })
                : t('loadedPartialNoTotal', { count: items.length })}
          </p>
        )}

        {/* GROUPED by kind — at-a-glance triage at scale (NOT a flat wall). */}
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <InboxGroupSection
              key={g.kind}
              group={g}
              onApprove={onApprove}
              onReject={onReject}
              busyId={busyId}
            />
          ))}
        </div>

        {/* Accumulate "load more" — pages the feed; grouping runs over the whole
            loaded set. Mirrors the documents feed's LoadMore. */}
        {feed.canLoadMore && (
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => feed.loadMore()}
              disabled={feed.isFetchingMore}
            >
              {feed.isFetchingMore ? t('loadingMore') : t('loadMore')}
            </Button>
          </div>
        )}
      </DataState>
    </div>
  );
}

/** The decision-TYPE filter rail — an "all" chip + one chip per kind currently
 *  present in the loaded feed. Calm chips; selecting narrows server-side. */
function KindFilter({
  active,
  groupsPresent,
  onChange,
}: {
  active: string | null;
  groupsPresent: string[];
  onChange: (kind: string | null) => void;
}) {
  const t = useTranslations('inbox');
  // Offer a chip for every KNOWN kind currently loaded (plus whatever is active,
  // so the active filter never vanishes when its group empties out).
  const kinds = useMemo(() => {
    const set = new Set(groupsPresent.filter((k) => k !== 'generic'));
    if (active) set.add(active);
    return KIND_GROUP_ORDER.filter((k) => set.has(k));
  }, [groupsPresent, active]);

  // Nothing to filter (0 or 1 kind loaded) — keep the surface calm, hide the rail.
  if (kinds.length < 2 && !active) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('filter.label')}>
      <FilterChip active={active === null} onClick={() => onChange(null)} label={t('filter.all')} />
      {kinds.map((k) => (
        <FilterChip
          key={k}
          active={active === k}
          onClick={() => onChange(active === k ? null : k)}
          label={t(`group.${k}`)}
        />
      ))}
    </div>
  );
}

function FilterChip({
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

/** One kind group: a heading (label + count) over the proposal cards for that
 *  kind. The heading reads the user-framed kind label (never a raw kind string);
 *  unmapped kinds use the generic heading. */
function InboxGroupSection({
  group,
  onApprove,
  onReject,
  busyId,
}: {
  group: InboxGroup;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  busyId: string | null;
}) {
  const t = useTranslations('inbox');
  const heading = group.isGeneric ? t('group.generic') : t(`group.${group.kind}`);

  return (
    <section aria-label={heading} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {heading}
        </h2>
        <span
          className="shrink-0 rounded-full px-1.5 text-xs tabular-nums"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
        >
          {t('group.count', { count: group.items.length })}
        </span>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {group.items.map((vm, i) => (
          <div
            key={vm.id}
            style={{
              borderBottom: i === group.items.length - 1 ? 0 : '1px solid var(--border)',
            }}
          >
            <ProposalCard
              vm={vm}
              onApprove={onApprove}
              onReject={onReject}
              isBusy={busyId === vm.id}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
