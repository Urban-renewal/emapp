'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { toApproveOutcome } from '@/adapters/proposal';
import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { DataState } from '@/components/ui/data-state';
import { useApproveProposal, useProposalList, useRejectProposal } from '@/hooks/use-proposals';
import type { ProposalApproveOutcome } from '@/models/proposal.vm';

import { ProposalCard } from './_components/proposal-card';

/** How long the outcome confirmation lingers (long enough to read; calm). */
const OUTCOME_TOAST_MS = 4000;

/**
 * Approval Inbox (Autonomous Master Plan, Phase 1) — the autonomy engine's
 * human-confirm surface. The user sees the system's PENDING PROPOSALS and
 * confirms each with one click: APPROVE (applies the gated action) or REJECT
 * (dismiss).
 *
 * VOICE LAW (owner-mandated, non-negotiable): the surface LEADS with the
 * user's pending decisions — "N החלטות ממתינות לך" — never the system's output
 * count ("הבוקר תזמנתי N"). The system is the user's instrument; the heading +
 * sub-line keep the feeling of control with the user. The per-row CTAs are the
 * user's verbs ([אשר]/[דחה]). Empty state = "אין החלטות ממתינות — הכל מסודר".
 *
 * Manager-only: the BE `requireManager` gate is authoritative; a non-manager
 * gets a 403, which `DataState` renders as the calm access-denied panel (NOT a
 * load error, no retry). RLS isolates per-org.
 *
 * One-click-and-gone: APPROVE / REJECT optimistically remove the row (the hook)
 * and fire an aria-live toast. A failed approve rolls the row back so it stays
 * actionable (M2 — per-item, never silently dropped).
 */
export function InboxListClient() {
  const t = useTranslations('inbox');
  const toast = useToast();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  const list = useProposalList({ limit: 25, cursor });
  const approve = useApproveProposal();
  const reject = useRejectProposal();

  const items = useMemo(() => list.data?.items ?? [], [list.data?.items]);
  const pendingCount = items.length;

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
    } catch {
      toast.show({ message: t('toast.failed'), variant: 'assertive' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* Situation header — LEADS with the user's pending decisions (voice law). */}
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('title')}
        </h1>
        {!list.isLoading && !list.isError && pendingCount > 0 && (
          <p className="text-[15px] font-medium" style={{ color: 'var(--text)' }}>
            {t('pendingLead', { count: pendingCount })}
          </p>
        )}
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {t('subtitle')}
        </p>
      </header>

      <DataState
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        onRetry={() => list.refetch()}
        skeleton="list"
        isEmpty={pendingCount === 0}
        emptyTitle={t('empty.title')}
        emptyHint={t('empty.hint')}
      >
        <div className="card" style={{ overflow: 'hidden' }}>
          {items.map((vm, i) => (
            <div
              key={vm.id}
              style={{
                borderBottom: i === items.length - 1 ? 0 : '1px solid var(--border)',
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

        {/* Pagination — keyset next/reset (mirrors notifications). */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {list.data?.page?.has_more && list.data.page.cursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCursor(list.data?.page?.cursor ?? undefined)}
            >
              {t('next')}
            </Button>
          )}
          {cursor && (
            <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
              {t('resetToFirstPage')}
            </Button>
          )}
        </div>
      </DataState>
    </div>
  );
}
